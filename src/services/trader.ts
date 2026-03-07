import { ClobClient } from '@polymarket/clob-client';
import { Side, OrderType } from '@polymarket/clob-client';
import type { CreateOrderOptions, TickSize } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Trade } from '../types/index.js';
import { errorLogger } from './errorLogger.js';

export interface TraderConfig {
  privateKey: string;
  funderAddress?: string; // Proxy wallet address (if different from signer)
  dryRun?: boolean; // If true, don't actually execute trades
  apiCredentials?: {
    key: string;
    secret: string;
    passphrase: string;
  };
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  error?: string;
  details?: {
    market: string;
    side: string;
    size: number;
    price: number;
  };
}

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon
// Signature type: 0 = EOA (signer IS funder), 2 = Poly Proxy (signer != funder)
// When FUNDER_ADDRESS is set and differs from the signer, we use Poly Proxy (2)
const EOA_SIGNATURE_TYPE = 0;
const POLY_PROXY_SIGNATURE_TYPE = 2;

export class Trader {
  private client: ClobClient | null = null;
  private config: TraderConfig;
  private isInitialized = false;

  constructor(config: TraderConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (this.config.dryRun) {
      console.log('[Trader] Running in DRY RUN mode - no real trades will be executed');
      this.isInitialized = true;
      return;
    }

    try {
      // Create viem account from private key
      const account = privateKeyToAccount(this.config.privateKey as `0x${string}`);
      const funderAddress = this.config.funderAddress || account.address;

      // Determine signature type based on whether funder differs from signer
      const sigType = funderAddress.toLowerCase() !== account.address.toLowerCase()
        ? POLY_PROXY_SIGNATURE_TYPE  // Proxy wallet: signer != funder
        : EOA_SIGNATURE_TYPE;        // EOA: signer == funder

      console.log('[Trader] Signer:', account.address);
      console.log('[Trader] Funder (proxy):', funderAddress);
      console.log('[Trader] Signature type:', sigType === POLY_PROXY_SIGNATURE_TYPE ? 'Poly Proxy (2)' : 'EOA (0)');

      // Create wallet client (required by ClobClient)
      const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http('https://polygon.drpc.org'),
      });

      // Use provided API credentials or derive them
      let creds = this.config.apiCredentials;

      if (!creds) {
        // Create CLOB client to derive credentials
        const tempClient = new ClobClient(
          CLOB_HOST,
          CHAIN_ID,
          walletClient,
          undefined,
          sigType,
          funderAddress,
        );

        // Derive API credentials
        creds = await tempClient.createOrDeriveApiKey();
        console.log('[Trader] API credentials derived successfully');
      } else {
        console.log('[Trader] Using provided API credentials');
      }

      // Initialize client with credentials
      this.client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        walletClient,
        creds,
        sigType,
        funderAddress,
      );

      this.isInitialized = true;
      console.log('[Trader] Initialized successfully');
    } catch (error) {
      errorLogger.logError('Trader.initialize', error);
      console.error('[Trader] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Get market options (tickSize, negRisk) for a token.
   * The ClobClient caches these internally.
   */
  private async getMarketOptions(tokenId: string): Promise<CreateOrderOptions> {
    if (!this.client) throw new Error('Client not initialized');

    const [tickSize, negRisk] = await Promise.all([
      this.client.getTickSize(tokenId),
      this.client.getNegRisk(tokenId),
    ]);

    return { tickSize, negRisk };
  }

  /**
   * Copy a trade from a tracked trader.
   * For BUY: amount is USD to spend.
   * For SELL: amount is USD value (will be converted to shares).
   */
  async copyTrade(
    originalTrade: Trade,
    amount: number, // Amount in USD
  ): Promise<TradeResult> {
    const side = originalTrade.side === 'BUY' ? Side.BUY : Side.SELL;
    const tokenId = originalTrade.asset;
    const price = parseFloat(String(originalTrade.price));

    // Calculate size (shares) from amount
    const size = amount / price;

    console.log(`[Trader] Copying trade:`);
    console.log(`  Token: ${tokenId.slice(0, 20)}...`);
    console.log(`  Side: ${side}`);
    console.log(`  Amount: $${amount.toFixed(2)}`);
    console.log(`  Price: $${price.toFixed(4)}`);
    console.log(`  Size: ${size.toFixed(2)} shares`);

    if (this.config.dryRun) {
      console.log(`[Trader] DRY RUN - Would execute trade`);
      return {
        success: true,
        orderId: 'dry-run-' + Date.now(),
        details: {
          market: originalTrade.title,
          side: originalTrade.side,
          size,
          price,
        },
      };
    }

    if (!this.client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      // Get market options (tickSize, negRisk) - required for order creation
      const options = await this.getMarketOptions(tokenId);

      if (side === Side.SELL) {
        // For SELL market orders: amount = number of shares to sell
        return await this.executeSellMarketOrder(tokenId, size, price, originalTrade.title, options);
      } else {
        // For BUY market orders: amount = USD to spend
        return await this.executeBuyMarketOrder(tokenId, amount, price, originalTrade.title, options);
      }
    } catch (error: any) {
      errorLogger.logError('Trader.copyTrade', error, { side: originalTrade.side, asset: originalTrade.asset?.slice(0, 30) });
      console.error(`[Trader] Order failed:`, error?.message || error);
      return {
        success: false,
        error: error?.message || 'Unknown error',
      };
    }
  }

  /**
   * Execute a BUY market order.
   * amount = USD to spend, price = max price willing to pay
   */
  private async executeBuyMarketOrder(
    tokenId: string,
    amount: number,
    price: number,
    title: string,
    options: CreateOrderOptions,
  ): Promise<TradeResult> {
    if (!this.client) return { success: false, error: 'Client not initialized' };

    // For BUY: amount is USD to spend
    const result = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount, // USD amount for BUY orders
        side: Side.BUY,
        price, // Max price limit (slippage protection)
      },
      options,
      OrderType.FOK, // Fill or Kill for buys - we want full fill or nothing
    );

    console.log(`[Trader] BUY order submitted:`, JSON.stringify(result));

    const size = amount / price;
    return {
      success: true,
      orderId: result?.orderID || result?.id,
      details: {
        market: title,
        side: 'BUY',
        size,
        price,
      },
    };
  }

  /**
   * Execute a SELL market order using FAK (Fill-And-Kill).
   * shares = number of shares to sell, minPrice = minimum acceptable price
   */
  private async executeSellMarketOrder(
    tokenId: string,
    shares: number,
    minPrice: number,
    title: string,
    options: CreateOrderOptions,
  ): Promise<TradeResult> {
    if (!this.client) return { success: false, error: 'Client not initialized' };

    // For SELL: amount is number of shares to sell (NOT USD!)
    const result = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: shares, // Shares to sell for SELL orders
        side: Side.SELL,
        price: Math.max(0.01, minPrice * 0.95), // Allow 5% slippage below target price
      },
      options,
      OrderType.FAK, // Fill-And-Kill: sell whatever liquidity is available, cancel rest
    );

    console.log(`[Trader] SELL order submitted:`, JSON.stringify(result));

    return {
      success: true,
      orderId: result?.orderID || result?.id,
      details: {
        market: title,
        side: 'SELL',
        size: shares,
        price: minPrice,
      },
    };
  }

  /**
   * Sell a specific position by token ID and share count.
   * Used by trailing stop, stop loss, take profit, and reconciler.
   */
  async sellPosition(
    tokenId: string,
    shares: number,
    currentBidPrice: number,
    title: string,
  ): Promise<TradeResult> {
    console.log(`[Trader] Selling position:`);
    console.log(`  Token: ${tokenId.slice(0, 20)}...`);
    console.log(`  Shares: ${shares.toFixed(4)}`);
    console.log(`  Bid Price: $${currentBidPrice.toFixed(4)}`);

    if (this.config.dryRun) {
      console.log(`[Trader] DRY RUN - Would sell position`);
      return {
        success: true,
        orderId: 'dry-run-' + Date.now(),
        details: {
          market: title,
          side: 'SELL',
          size: shares,
          price: currentBidPrice,
        },
      };
    }

    if (!this.client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const options = await this.getMarketOptions(tokenId);
      return await this.executeSellMarketOrder(tokenId, shares, currentBidPrice, title, options);
    } catch (error: any) {
      errorLogger.logError('Trader.sellPosition', error, { tokenId: tokenId?.slice(0, 30), shares });
      console.error(`[Trader] Sell failed:`, error?.message || error);
      return {
        success: false,
        error: error?.message || 'Unknown error',
      };
    }
  }

  /**
   * Update balance allowance for GTC orders.
   * Must be called after buying before placing GTC sell limit orders,
   * otherwise Polymarket rejects with "not enough balance / allowance".
   */
  async updateBalanceAllowance(): Promise<void> {
    if (!this.client || this.config.dryRun) return;

    try {
      await this.client.updateBalanceAllowance();
      console.log('[Trader] Balance allowance updated');
    } catch (error: any) {
      console.warn('[Trader] Balance allowance update failed:', error?.message);
    }
  }

  async placeLimitOrder(
    tokenId: string,
    side: 'BUY' | 'SELL',
    size: number,
    price: number,
  ): Promise<TradeResult> {
    if (this.config.dryRun) {
      console.log(`[Trader] DRY RUN - Would place limit order`);
      return {
        success: true,
        orderId: 'dry-run-' + Date.now(),
        details: { market: tokenId, side, size, price },
      };
    }

    if (!this.client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const options = await this.getMarketOptions(tokenId);

      const result = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          size,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          price,
        },
        options,
        OrderType.GTC, // Good til cancelled
      );

      return {
        success: true,
        orderId: result?.orderID || result?.id,
        details: { market: tokenId, side, size, price },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Unknown error',
      };
    }
  }

  async cancelOrders(orderIds: string[]): Promise<boolean> {
    if (!this.client || orderIds.length === 0) return false;

    try {
      await this.client.cancelOrders(orderIds);
      console.log(`[Trader] Cancelled ${orderIds.length} order(s)`);
      return true;
    } catch (error) {
      console.error('[Trader] Failed to cancel orders:', error);
      return false;
    }
  }

  async cancelAllOrders(): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.cancelAll();
      console.log('[Trader] All orders cancelled');
      return true;
    } catch (error) {
      console.error('[Trader] Failed to cancel orders:', error);
      return false;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.client) return [];

    try {
      const result = await this.client.getOpenOrders();
      return (result as any)?.orders || result || [];
    } catch (error) {
      console.error('[Trader] Failed to get open orders:', error);
      return [];
    }
  }

  isDryRun(): boolean {
    return this.config.dryRun || false;
  }

  /**
   * Update dry run mode (for hot-reload support)
   */
  setDryRun(dryRun: boolean): void {
    const previousMode = this.config.dryRun;
    this.config.dryRun = dryRun;

    if (previousMode !== dryRun) {
      console.log(`[Trader] Dry run mode changed: ${previousMode ? 'DRY RUN' : 'LIVE'} -> ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    }
  }
}
