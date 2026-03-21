import { DataApiClient } from '../api/dataApi.js';
import { OnchainClient } from '../api/onchain.js';
import { Trade } from '../types/index.js';

export interface TraderProfile {
  address: string;
  totalValue: number;
  positionsValue: number;
  usdcBalance: number;
  lastUpdated: number;
}

export interface PositionSizeResult {
  originalTradeValue: number;
  traderAccountSize: number;
  tradePercentage: number;
  yourAccountSize: number;
  recommendedSize: number;
  cappedSize: number;
  reason: string;
}

export class PositionSizer {
  private dataApi: DataApiClient;
  private onchainClient: OnchainClient;
  private traderProfiles: Map<string, TraderProfile> = new Map();
  private profileCacheTtl = 600000; // Cache for 10 minutes
  private userAccountSize: number;
  private maxPositionSize: number;
  private minTradeSize: number;
  private maxPercentage: number;
  private fixedTradePercent?: number;

  constructor(config: {
    userAccountSize: number;
    maxPositionSize: number;
    minTradeSize: number;
    maxPercentage?: number; // Max % of your account per trade (safety)
    fixedTradePercent?: number; // If set, use fixed % per trade instead of proportional
  }) {
    this.dataApi = new DataApiClient();
    this.onchainClient = new OnchainClient();
    this.userAccountSize = config.userAccountSize;
    this.maxPositionSize = config.maxPositionSize;
    this.minTradeSize = config.minTradeSize;
    this.maxPercentage = config.maxPercentage || 10; // Default 10% max per trade
    this.fixedTradePercent = config.fixedTradePercent;
  }

  async getTraderProfile(walletAddress: string): Promise<TraderProfile> {
    const cached = this.traderProfiles.get(walletAddress);
    const now = Date.now();

    if (cached && (now - cached.lastUpdated) < this.profileCacheTtl) {
      return cached;
    }

    console.log(`[Sizer] Fetching account size for ${walletAddress.slice(0, 10)}...`);

    // Get USDC balance from on-chain (parallel with positions fetch)
    const usdcPromise = this.onchainClient.getUsdcBalance(walletAddress);

    // Get all positions to calculate total value
    let totalPositionsValue = 0;
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const positions = await this.dataApi.getPositions(walletAddress, {
        limit,
        offset,
        sizeThreshold: 0.01 // Ignore dust
      });

      if (positions.length === 0) {
        hasMore = false;
        break;
      }

      for (const pos of positions) {
        const value = parseFloat(pos.currentValue) || 0;
        totalPositionsValue += value;
      }

      if (positions.length < limit) {
        hasMore = false;
      }
      offset += limit;

      // Safety limit - don't fetch forever
      if (offset > 10000) break;
    }

    // Wait for USDC balance
    const usdcBalance = await usdcPromise;
    const totalValue = totalPositionsValue + usdcBalance;

    const profile: TraderProfile = {
      address: walletAddress,
      totalValue,
      positionsValue: totalPositionsValue,
      usdcBalance,
      lastUpdated: now,
    };

    this.traderProfiles.set(walletAddress, profile);
    console.log(`[Sizer] ${walletAddress.slice(0, 10)}... Positions: $${totalPositionsValue.toFixed(2)} + USDC: $${usdcBalance.toFixed(2)} = Total: $${totalValue.toFixed(2)}`);

    return profile;
  }

  async calculatePositionSize(
    trade: Trade,
    traderAddress: string
  ): Promise<PositionSizeResult> {
    // Get trader's account size
    const traderProfile = await this.getTraderProfile(traderAddress);

    // Calculate trade value
    const tradeSize = parseFloat(trade.size);
    const tradePrice = parseFloat(String(trade.price));
    const originalTradeValue = tradeSize * tradePrice;

    // Calculate percentage of trader's account
    let tradePercentage = 0;
    if (traderProfile.totalValue > 0) {
      tradePercentage = (originalTradeValue / traderProfile.totalValue) * 100;
    }

    // Determine sizing method
    let recommendedSize: number;
    let reason: string;

    if (this.fixedTradePercent !== undefined && this.fixedTradePercent > 0) {
      // Fixed percentage mode - ignore trader's account size
      recommendedSize = (this.fixedTradePercent / 100) * this.userAccountSize;
      reason = `fixed ${this.fixedTradePercent}% per trade`;
    } else {
      // Mirror mode — copy the trader's exact dollar amount, capped by limits.
      // If RN1 bets $3, we bet $3. If RN1 bets $500, we cap at maxPositionSize.
      recommendedSize = originalTradeValue;
      reason = `mirror $${originalTradeValue.toFixed(2)}`;
    }

    // Apply caps and floors
    let cappedSize = recommendedSize;

    // Cap at max position size
    if (cappedSize > this.maxPositionSize) {
      cappedSize = this.maxPositionSize;
      reason = `capped at max $${this.maxPositionSize}`;
    }

    // Cap at max percentage of your account
    const maxAllowed = (this.maxPercentage / 100) * this.userAccountSize;
    if (cappedSize > maxAllowed) {
      cappedSize = maxAllowed;
      reason = `capped at ${this.maxPercentage}% of account`;
    }

    // Floor at min trade size (USD minimum)
    if (cappedSize < this.minTradeSize) {
      if (recommendedSize >= 0.1) {
        // Trade is meaningful but below minimum - bump up
        cappedSize = this.minTradeSize;
        reason = `raised to min $${this.minTradeSize}`;
      } else {
        // Trade is too small to copy
        cappedSize = 0;
        reason = 'skipped (too small)';
      }
    }

    // Polymarket's actual minimum is ~$1 or ~1 share, not 5.
    // Let the exchange reject if truly too small — don't over-filter here.

    return {
      originalTradeValue,
      traderAccountSize: traderProfile.totalValue,
      tradePercentage,
      yourAccountSize: this.userAccountSize,
      recommendedSize,
      cappedSize,
      reason,
    };
  }

  updateUserAccountSize(newSize: number): void {
    this.userAccountSize = newSize;
    console.log(`[Sizer] Updated your account size: $${newSize}`);
  }

  // Force refresh a trader's profile
  async refreshTraderProfile(walletAddress: string): Promise<TraderProfile> {
    this.traderProfiles.delete(walletAddress);
    return this.getTraderProfile(walletAddress);
  }

  getStats(): {
    userAccountSize: number;
    maxPositionSize: number;
    minTradeSize: number;
    maxPercentage: number;
    cachedTraders: number;
  } {
    return {
      userAccountSize: this.userAccountSize,
      maxPositionSize: this.maxPositionSize,
      minTradeSize: this.minTradeSize,
      maxPercentage: this.maxPercentage,
      cachedTraders: this.traderProfiles.size,
    };
  }
}
