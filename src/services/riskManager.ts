import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { ClobApiClient } from '../api/clobApi.js';

export interface RiskConfig {
  // Stop loss: sell if position drops below this % (e.g., -20 means sell at 20% loss)
  stopLossPercent?: number;

  // Take profit: sell if position gains above this % (e.g., 50 means sell at 50% gain)
  takeProfitPercent?: number;

  // Maximum age of trade signal to copy (in seconds)
  maxTradeAgeSeconds?: number;

  // Maximum spread to accept (e.g., 0.05 = 5%)
  maxSpreadPercent?: number;

  // How often to check positions for stop loss/take profit (ms)
  checkIntervalMs?: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
}

export class RiskManager {
  private config: RiskConfig;
  private stateManager: StateManager;
  private trader: Trader | null;
  private clobApi: ClobApiClient;
  private checkInterval: NodeJS.Timeout | null = null;
  private dryRun: boolean;

  constructor(
    config: RiskConfig,
    stateManager: StateManager,
    trader: Trader | null,
    dryRun: boolean = true
  ) {
    this.config = {
      stopLossPercent: config.stopLossPercent ?? -25, // Default: -25%
      takeProfitPercent: config.takeProfitPercent ?? 100, // Default: +100%
      maxTradeAgeSeconds: config.maxTradeAgeSeconds ?? 60, // Default: 1 minute
      maxSpreadPercent: config.maxSpreadPercent ?? 0.10, // Default: 10%
      checkIntervalMs: config.checkIntervalMs ?? 60000, // Default: every minute
    };
    this.stateManager = stateManager;
    this.trader = trader;
    this.clobApi = new ClobApiClient();
    this.dryRun = dryRun;
  }

  /**
   * Check if a trade signal passes risk checks
   */
  async checkTradeSignal(
    tradeTimestamp: number,
    tokenId: string
  ): Promise<RiskCheckResult> {
    // Check trade age
    const ageSeconds = (Date.now() / 1000) - tradeTimestamp;
    if (ageSeconds > this.config.maxTradeAgeSeconds!) {
      return {
        passed: false,
        reason: `Trade too old (${ageSeconds.toFixed(0)}s > ${this.config.maxTradeAgeSeconds}s max)`,
      };
    }

    // Check spread
    try {
      const spread = await this.clobApi.getSpread(tokenId);
      const spreadPercent = parseFloat(spread.spread) / parseFloat(spread.mid || '1');

      if (spreadPercent > this.config.maxSpreadPercent!) {
        return {
          passed: false,
          reason: `Spread too wide (${(spreadPercent * 100).toFixed(1)}% > ${(this.config.maxSpreadPercent! * 100).toFixed(0)}% max)`,
        };
      }
    } catch (error) {
      // If we can't check spread, allow the trade
      console.warn('[RiskManager] Could not check spread:', error);
    }

    return { passed: true };
  }

  /**
   * Start monitoring positions for stop loss / take profit
   */
  startMonitoring(): void {
    if (this.checkInterval) return;

    console.log(`[RiskManager] Starting position monitoring`);
    console.log(`  Stop Loss: ${this.config.stopLossPercent}%`);
    console.log(`  Take Profit: +${this.config.takeProfitPercent}%`);
    console.log(`  Max Trade Age: ${this.config.maxTradeAgeSeconds}s`);
    console.log(`  Max Spread: ${(this.config.maxSpreadPercent! * 100).toFixed(0)}%`);

    this.checkInterval = setInterval(() => {
      this.checkPositions();
    }, this.config.checkIntervalMs);

    // Run immediately
    this.checkPositions();
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[RiskManager] Stopped');
    }
  }

  private async checkPositions(): Promise<void> {
    const positions = this.stateManager.getAllPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      try {
        // Get current price
        const spread = await this.clobApi.getSpread(position.asset);
        const currentPrice = parseFloat(spread.mid || spread.bid || '0');

        if (currentPrice === 0 || position.avgPrice === 0) continue;

        // Calculate P&L %
        const pnlPercent = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;

        // Check stop loss
        if (pnlPercent <= this.config.stopLossPercent!) {
          console.log(`\n⚠️ STOP LOSS TRIGGERED:`);
          console.log(`  ${position.title} - ${position.outcome}`);
          console.log(`  Entry: $${position.avgPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)}`);
          console.log(`  P&L: ${pnlPercent.toFixed(1)}% (limit: ${this.config.stopLossPercent}%)`);

          await this.sellPosition(position, 'Stop Loss');
        }

        // Check take profit
        if (pnlPercent >= this.config.takeProfitPercent!) {
          console.log(`\n🎯 TAKE PROFIT TRIGGERED:`);
          console.log(`  ${position.title} - ${position.outcome}`);
          console.log(`  Entry: $${position.avgPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)}`);
          console.log(`  P&L: +${pnlPercent.toFixed(1)}% (target: +${this.config.takeProfitPercent}%)`);

          await this.sellPosition(position, 'Take Profit');
        }
      } catch (error) {
        // Silently continue on error
      }
    }
  }

  private async sellPosition(
    position: { asset: string; size: number; title: string; outcome: string; avgPrice: number },
    reason: string
  ): Promise<void> {
    if (this.dryRun) {
      console.log(`  [DRY RUN] Would sell ${position.size.toFixed(4)} shares`);
      return;
    }

    if (!this.trader) {
      console.log(`  [Error] Trader not available`);
      return;
    }

    try {
      // Get current bid price
      const spread = await this.clobApi.getSpread(position.asset);
      const sellPrice = Math.max(0.01, parseFloat(spread.bid || '0.5'));

      const trade = {
        asset: position.asset,
        side: 'SELL' as const,
        size: position.size,
        price: sellPrice,
        title: position.title,
        outcome: position.outcome,
        timestamp: Math.floor(Date.now() / 1000),
      };

      const amount = position.size * sellPrice;
      const result = await this.trader.copyTrade(trade as any, amount);

      if (result.success) {
        console.log(`  ✅ ${reason} executed - Order ID: ${result.orderId}`);
        this.stateManager.updatePosition(position.asset, -position.size, sellPrice);
      } else {
        console.log(`  ❌ ${reason} failed: ${result.error}`);
      }
    } catch (error: any) {
      console.log(`  ❌ ${reason} error: ${error?.message || error}`);
    }
  }
}
