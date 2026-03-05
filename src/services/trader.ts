import { ClobClient } from '@polymarket/clob-client';
import { Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Trade } from '../types/index.js';

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
const SIGNATURE_TYPE = 2; // GNOSIS_SAFE for browser wallet / proxy wallet users

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

      console.log('[Trader] Signer:', account.address);
      console.log('[Trader] Funder (proxy):', funderAddress);

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
          SIGNATURE_TYPE,
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
        SIGNATURE_TYPE,
        funderAddress,
      );

      this.isInitialized = true;
      console.log('[Trader] Initialized successfully');
    } catch (error) {
      console.error('[Trader] Failed to initialize:', error);
      throw error;
    }
  }

  async copyTrade(
    originalTrade: Trade,
    amount: number, // Amount in USD to spend
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
      // Create and post market order (FOK - Fill or Kill)
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount, // USD amount for market orders
          side,
          feeRateBps: 0, // Will be fetched automatically
          nonce: 0, // Will be generated
          price, // Price limit
        },
        undefined, // options
        OrderType.FOK, // Fill or Kill
      );

      console.log(`[Trader] Order submitted:`, result);

      return {
        success: true,
        orderId: result?.orderID || result?.id,
        details: {
          market: originalTrade.title,
          side: originalTrade.side,
          size,
          price,
        },
      };
    } catch (error: any) {
      console.error(`[Trader] Order failed:`, error?.message || error);
      return {
        success: false,
        error: error?.message || 'Unknown error',
      };
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
      const result = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          size,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          price,
        },
        undefined,
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
}
