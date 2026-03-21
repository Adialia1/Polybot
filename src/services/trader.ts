import { ClobClient } from '@polymarket/clob-client';
import { Side, OrderType, AssetType } from '@polymarket/clob-client';
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
  status?: 'filled' | 'delayed' | 'unknown';
  details?: {
    market: string;
    side: string;
    size: number;
    price: number;
  };
}

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon
// Polymarket signature types (from official docs):
//   0 = EOA: standalone wallet, signer IS funder, you pay gas directly
//   1 = POLY_PROXY: Magic Link / email login, exported PK from polymarket.com
//   2 = GNOSIS_SAFE: browser wallet (MetaMask/Rabby) with Polymarket proxy wallet (most common)
const EOA_SIGNATURE_TYPE = 0;
const GNOSIS_SAFE_SIGNATURE_TYPE = 2;

// Slippage tolerance for market orders — configurable via env
// BUY: allow price up to X% above trader's price to ensure fill
// SELL: allow price down to X% below target price
// Polymarket moves fast, especially sports markets. 5% is too low for copy trading.
const MARKET_ORDER_SLIPPAGE = parseFloat(process.env.ORDER_SLIPPAGE_PERCENT || '15') / 100;

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

      // Signature type: configurable via SIGNATURE_TYPE env var, or auto-detect
      // 0 = EOA (standalone wallet, signer IS funder)
      // 1 = POLY_PROXY (email/Magic Link login, exported PK from Polymarket)
      // 2 = GNOSIS_SAFE (browser wallet like MetaMask with proxy)
      const sigTypeNames = ['EOA (0)', 'Poly Proxy (1)', 'Gnosis Safe (2)'];
      let sigType: number;
      if (process.env.SIGNATURE_TYPE !== undefined && process.env.SIGNATURE_TYPE !== '') {
        sigType = parseInt(process.env.SIGNATURE_TYPE, 10);
      } else {
        sigType = funderAddress.toLowerCase() !== account.address.toLowerCase()
          ? GNOSIS_SAFE_SIGNATURE_TYPE
          : EOA_SIGNATURE_TYPE;
      }

      console.log('[Trader] Signer:', account.address);
      console.log('[Trader] Funder (proxy):', funderAddress);
      console.log('[Trader] Signature type:', sigTypeNames[sigType] || `Unknown (${sigType})`);

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
   * Check if an error message indicates a non-retryable (permanent) failure.
   * These errors won't be resolved by retrying - they need parameter changes.
   */
  static isNonRetryableError(errorMessage: string): boolean {
    const nonRetryablePatterns = [
      'invalid amount',
      'min size',
      'minimum',
      'lower than the minimum',
      'invalid order',
      'invalid signature',
      'not enough balance',
      'not enough allowance',
      'market is not yet ready',
      'invalid post-only order',
      'INVALID_ORDER_MIN_SIZE',
      'INVALID_ORDER_MIN_TICK_SIZE',
      'INVALID_ORDER_NOT_ENOUGH_BALANCE',
      'no liquidity',
      'not filled',
      'below minimum share count',
    ];
    const lowerError = errorMessage.toLowerCase();
    return nonRetryablePatterns.some(pattern => lowerError.includes(pattern.toLowerCase()));
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

    // Polymarket's actual minimum is ~$1 / ~1 share. Let the exchange reject if too small.

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
   * Helper to wait a given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if a submitted order was actually filled by querying its status.
   * Uses the CLOB getOrder endpoint which returns OpenOrder with:
   *   - status: "live" | "matched" | "cancelled" | "delayed" etc.
   *   - size_matched: string (number of shares filled)
   *   - price: string (order price)
   */
  private async verifyOrderFill(orderId: string, maxWaitMs: number = 10000): Promise<{
    filled: boolean;
    filledSize: number;
    avgPrice: number;
  }> {
    if (!this.client) return { filled: false, filledSize: 0, avgPrice: 0 };

    const startTime = Date.now();
    const checkIntervals = [3000, 3000, 4000]; // Wait 3s, 3s, 4s = 10s total

    for (let i = 0; i < checkIntervals.length; i++) {
      if (Date.now() - startTime > maxWaitMs) break;
      await this.delay(checkIntervals[i]);

      try {
        const order = await this.client.getOrder(orderId);
        const status = order?.status?.toUpperCase();
        const filledSize = parseFloat(order?.size_matched || '0');
        const orderPrice = parseFloat(order?.price || '0');

        // Only log meaningful status changes (not every undefined poll)
        if (status || filledSize > 0) {
          console.log(`[Trader] Order check: status=${order?.status}, filled=${filledSize}`);
        }

        // Definitively filled
        if (status === 'MATCHED' || filledSize > 0) {
          return { filled: true, filledSize, avgPrice: orderPrice };
        }

        // Definitively not filled — stop waiting
        if (status === 'CANCELLED' || status === 'EXPIRED') {
          console.log(`[Trader] Order ${orderId.slice(0, 16)}... ${order?.status} (not filled)`);
          return { filled: false, filledSize: 0, avgPrice: 0 };
        }

        // If order returns nothing (undefined status), the FAK order was likely
        // already killed and removed from the system — no fill occurred
        if (!status && i >= 1) {
          // After 2+ checks with no status, assume killed
          return { filled: false, filledSize: 0, avgPrice: 0 };
        }
      } catch (err: any) {
        // API error on order lookup — might mean order doesn't exist (killed)
        if (i >= 1) {
          return { filled: false, filledSize: 0, avgPrice: 0 };
        }
      }
    }

    return { filled: false, filledSize: 0, avgPrice: 0 };
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
    // Use FAK (Fill-And-Kill) instead of FOK for better fill rates on small orders.
    // FOK requires exact full fill or cancels entirely — FAK fills whatever liquidity
    // is available and cancels the remainder, which is better for small accounts.
    //
    // IMPORTANT: Add slippage tolerance to the price limit! The trader's execution price
    // is often stale by the time we copy. Without tolerance, orders won't fill if
    // the market moved even 1 cent above the trader's price.
    const buyPriceLimit = Math.min(0.99, price * (1 + MARKET_ORDER_SLIPPAGE));
    console.log(`[Trader] BUY price limit: $${buyPriceLimit.toFixed(4)} (trader: $${price.toFixed(4)}, +${(MARKET_ORDER_SLIPPAGE * 100).toFixed(0)}% slippage)`);

    const result = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount, // USD amount for BUY orders
        side: Side.BUY,
        price: buyPriceLimit, // Max price with slippage tolerance
      },
      options,
      OrderType.FAK, // Fill-And-Kill: fills available liquidity, cancels rest
    );

    console.log(`[Trader] BUY order submitted:`, JSON.stringify(result));

    // Check if the order was rejected
    const resultAny = result as any;
    if (resultAny?.error || resultAny?.status === 400) {
      return {
        success: false,
        error: resultAny.error || 'Order rejected by exchange',
      };
    }

    const orderId = resultAny?.orderID || resultAny?.id;
    if (!orderId) {
      return {
        success: false,
        error: 'No order ID returned - order may not have been placed',
      };
    }

    // Check if the response indicates immediate fill
    const status = resultAny?.status;
    const takingAmount = resultAny?.takingAmount;
    const makingAmount = resultAny?.makingAmount;
    const immediatelyFilled = status === 'matched' ||
      (takingAmount && takingAmount !== '' && takingAmount !== '0') ||
      (makingAmount && makingAmount !== '' && makingAmount !== '0');

    if (immediatelyFilled) {
      // Order filled immediately
      const size = amount / price;
      return {
        success: true,
        status: 'filled',
        orderId,
        details: { market: title, side: 'BUY', size, price },
      };
    }

    // Order is "delayed" - verify if it actually fills
    if (status === 'delayed') {
      console.log(`[Trader] Order ${orderId.slice(0, 16)}... is delayed, verifying fill...`);
      const fillResult = await this.verifyOrderFill(orderId);

      if (fillResult.filled && fillResult.filledSize > 0) {
        const actualPrice = fillResult.avgPrice || price;
        console.log(`[Trader] Order CONFIRMED filled: ${fillResult.filledSize.toFixed(4)} shares @ $${actualPrice.toFixed(4)}`);
        return {
          success: true,
          status: 'filled',
          orderId,
          details: {
            market: title,
            side: 'BUY',
            size: fillResult.filledSize,
            price: actualPrice,
          },
        };
      } else {
        console.log(`[Trader] Order NOT filled - no liquidity at price $${price.toFixed(4)}`);
        return {
          success: false,
          status: 'delayed',
          orderId,
          error: `Order delayed but not filled - likely no liquidity at $${price.toFixed(4)}`,
        };
      }
    }

    // Unknown status but has orderID - treat as potentially delayed
    const size = amount / price;
    console.log(`[Trader] Order submitted with status: ${status || 'unknown'}, will verify...`);
    const fillResult = await this.verifyOrderFill(orderId);

    if (fillResult.filled && fillResult.filledSize > 0) {
      return {
        success: true,
        status: 'filled',
        orderId,
        details: {
          market: title,
          side: 'BUY',
          size: fillResult.filledSize,
          price: fillResult.avgPrice || price,
        },
      };
    }

    // If we still can't confirm, report as failed
    return {
      success: false,
      status: 'unknown',
      orderId,
      error: `Order submitted but fill not confirmed (status: ${status || 'unknown'})`,
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
    const sellPriceLimit = Math.max(0.01, minPrice * (1 - MARKET_ORDER_SLIPPAGE));
    console.log(`[Trader] SELL price limit: $${sellPriceLimit.toFixed(4)} (target: $${minPrice.toFixed(4)}, -${(MARKET_ORDER_SLIPPAGE * 100).toFixed(0)}% slippage)`);

    const result = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: shares, // Shares to sell for SELL orders
        side: Side.SELL,
        price: sellPriceLimit, // Min price with slippage tolerance
      },
      options,
      OrderType.FAK, // Fill-And-Kill: sell whatever liquidity is available, cancel rest
    );

    console.log(`[Trader] SELL order submitted:`, JSON.stringify(result));

    // Check if the order was rejected
    const resultAny = result as any;
    if (resultAny?.error || resultAny?.status === 400) {
      return {
        success: false,
        error: resultAny.error || 'Order rejected by exchange',
      };
    }

    const orderId = resultAny?.orderID || resultAny?.id;
    if (!orderId) {
      return {
        success: false,
        error: 'No order ID returned - order may not have been placed',
      };
    }

    // Check if immediately filled
    const status = resultAny?.status;
    const takingAmount = resultAny?.takingAmount;
    const makingAmount = resultAny?.makingAmount;
    const immediatelyFilled = status === 'matched' ||
      (takingAmount && takingAmount !== '' && takingAmount !== '0') ||
      (makingAmount && makingAmount !== '' && makingAmount !== '0');

    if (immediatelyFilled) {
      return {
        success: true,
        status: 'filled',
        orderId,
        details: { market: title, side: 'SELL', size: shares, price: minPrice },
      };
    }

    // Verify delayed order
    if (status === 'delayed' || !immediatelyFilled) {
      console.log(`[Trader] SELL order ${orderId.slice(0, 16)}... is ${status || 'pending'}, verifying fill...`);
      const fillResult = await this.verifyOrderFill(orderId);

      if (fillResult.filled && fillResult.filledSize > 0) {
        console.log(`[Trader] SELL CONFIRMED: ${fillResult.filledSize.toFixed(4)} shares`);
        return {
          success: true,
          status: 'filled',
          orderId,
          details: {
            market: title,
            side: 'SELL',
            size: fillResult.filledSize,
            price: fillResult.avgPrice || minPrice,
          },
        };
      } else {
        return {
          success: false,
          status: 'delayed',
          orderId,
          error: `SELL order not filled - likely no buy-side liquidity`,
        };
      }
    }

    return {
      success: true,
      status: 'unknown',
      orderId,
      details: { market: title, side: 'SELL', size: shares, price: minPrice },
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
  async updateBalanceAllowance(tokenId?: string): Promise<void> {
    if (!this.client || this.config.dryRun) return;

    try {
      // For conditional tokens (ERC1155), must pass the specific token_id
      const params: any = { asset_type: AssetType.CONDITIONAL };
      if (tokenId) {
        params.token_id = tokenId;
      }
      await this.client.updateBalanceAllowance(params);
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

      // Check if the order actually succeeded
      const resultAny = result as any;
      if (resultAny?.error || resultAny?.status === 400) {
        return {
          success: false,
          error: resultAny.error || 'Order rejected by exchange',
        };
      }

      if (!resultAny?.orderID && !resultAny?.id && resultAny?.success !== true) {
        return {
          success: false,
          error: 'No order ID returned',
        };
      }

      return {
        success: true,
        orderId: resultAny?.orderID || resultAny?.id,
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
