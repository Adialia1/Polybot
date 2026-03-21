import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { TelegramNotifier } from './notifier.js';
import { ClobApiClient } from '../api/clobApi.js';
import { errorLogger } from './errorLogger.js';

export interface RiskConfig {
  // Stop loss: sell if position drops below this % (e.g., -20 means sell at 20% loss)
  stopLossPercent?: number;

  // Take profit: sell if position gains above this % (e.g., 50 means sell at 50% gain)
  takeProfitPercent?: number;

  // Maximum age of trade signal to copy (in seconds)
  maxTradeAgeSeconds?: number;

  // Maximum price difference from trader's entry to accept (e.g., 5 = 5%)
  maxPriceDiffPercent?: number;

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
  private notifier: TelegramNotifier | null;
  private clobApi: ClobApiClient;
  private checkInterval: NodeJS.Timeout | null = null;
  private dryRun: boolean;

  constructor(
    config: RiskConfig,
    stateManager: StateManager,
    trader: Trader | null,
    dryRun: boolean = true,
    notifier: TelegramNotifier | null = null
  ) {
    this.config = {
      stopLossPercent: config.stopLossPercent ?? -25, // Default: -25%
      takeProfitPercent: config.takeProfitPercent ?? 100, // Default: +100%
      maxTradeAgeSeconds: config.maxTradeAgeSeconds ?? 60, // Default: 1 minute
      maxPriceDiffPercent: config.maxPriceDiffPercent ?? 5, // Default: 5%
      checkIntervalMs: config.checkIntervalMs ?? 60000, // Default: every minute
    };
    this.stateManager = stateManager;
    this.trader = trader;
    this.notifier = notifier;
    this.clobApi = new ClobApiClient();
    this.dryRun = dryRun;
  }

  /**
   * Check if a trade signal passes risk checks
   */
  async checkTradeSignal(
    tradeTimestamp: number,
    tokenId: string,
    traderPrice: number,
    side: 'BUY' | 'SELL'
  ): Promise<RiskCheckResult> {
    // Check trade age
    const ageSeconds = (Date.now() / 1000) - tradeTimestamp;
    if (ageSeconds > this.config.maxTradeAgeSeconds!) {
      return {
        passed: false,
        reason: `Trade too old (${ageSeconds.toFixed(0)}s > ${this.config.maxTradeAgeSeconds}s max)`,
      };
    }

    // Check price difference from trader's entry
    // Only reject UNFAVORABLE moves:
    //   BUY: reject if price went UP (more expensive for us)
    //   SELL: reject if price went DOWN (worse exit for us)
    // Favorable moves (discounts) are allowed regardless of size
    try {
      const currentPrice = parseFloat(await this.clobApi.getPrice(tokenId, side));
      if (traderPrice > 0 && currentPrice > 0) {
        const priceDiff = currentPrice - traderPrice;
        const priceDiffPercent = (priceDiff / traderPrice) * 100;

        // For BUY: positive diff = price went up (bad), negative = discount (good)
        // For SELL: negative diff = price went down (bad), positive = better exit (good)
        const isUnfavorable = (side === 'BUY' && priceDiff > 0) || (side === 'SELL' && priceDiff < 0);

        if (isUnfavorable && Math.abs(priceDiffPercent) > this.config.maxPriceDiffPercent!) {
          return {
            passed: false,
            reason: `Price moved unfavorably (${priceDiffPercent.toFixed(1)}% | trader: $${traderPrice.toFixed(3)}, current: $${currentPrice.toFixed(3)})`,
          };
        }
      }
    } catch (error) {
      // If we can't check price, allow the trade
      console.warn('[RiskManager] Could not check price:', error);
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
    console.log(`  Max Price Diff: ${this.config.maxPriceDiffPercent}%`);

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

  updateConfig(newConfig: Partial<RiskConfig>): void {
    if (newConfig.stopLossPercent !== undefined) {
      this.config.stopLossPercent = newConfig.stopLossPercent;
      console.log(`[RiskManager] Updated stopLossPercent to ${newConfig.stopLossPercent}%`);
    }
    if (newConfig.takeProfitPercent !== undefined) {
      this.config.takeProfitPercent = newConfig.takeProfitPercent;
      console.log(`[RiskManager] Updated takeProfitPercent to +${newConfig.takeProfitPercent}%`);
    }
  }

  private async checkPositions(): Promise<void> {
    const positions = this.stateManager.getAllPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      try {
        // Get current price
        const spread = await this.clobApi.getSpread(position.asset);
        const mid = ((parseFloat(spread.bid) + parseFloat(spread.ask)) / 2).toString();
        const currentPrice = parseFloat(mid || spread.bid || '0');

        // Skip resolved markets or empty orderbooks ($0.01-0.02)
        if (currentPrice <= 0.02 || position.avgPrice === 0) continue;

        // Calculate P&L %
        const pnlPercent = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;

        // Check stop loss
        if (pnlPercent <= this.config.stopLossPercent!) {
          console.log(`\n⚠️ STOP LOSS TRIGGERED:`);
          console.log(`  ${position.title} - ${position.outcome}`);
          console.log(`  Entry: $${position.avgPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)}`);
          console.log(`  P&L: ${pnlPercent.toFixed(1)}% (limit: ${this.config.stopLossPercent}%)`);

          await this.sellPosition(position, 'Stop Loss', currentPrice, pnlPercent);
        }

        // Check take profit
        if (pnlPercent >= this.config.takeProfitPercent!) {
          console.log(`\n🎯 TAKE PROFIT TRIGGERED:`);
          console.log(`  ${position.title} - ${position.outcome}`);
          console.log(`  Entry: $${position.avgPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)}`);
          console.log(`  P&L: +${pnlPercent.toFixed(1)}% (target: +${this.config.takeProfitPercent}%)`);

          await this.sellPosition(position, 'Take Profit', currentPrice, pnlPercent);
        }
      } catch (error: any) {
        errorLogger.logError('RiskManager.checkPosition', error, { asset: position.asset?.slice(0, 30), title: position.title?.slice(0, 40) });
      }
    }
  }

  private async sellPosition(
    position: { asset: string; size: number; title: string; outcome: string; avgPrice: number },
    reason: string,
    currentPrice: number,
    pnlPercent: number
  ): Promise<void> {
    const triggerType = reason === 'Stop Loss' ? 'STOP_LOSS' : 'TAKE_PROFIT';

    if (this.dryRun) {
      console.log(`  [DRY RUN] Would sell ${position.size.toFixed(4)} shares`);
      // Still send notification for dry run
      if (this.notifier) {
        await this.notifier.notifyRiskTrigger({
          type: triggerType as 'STOP_LOSS' | 'TAKE_PROFIT',
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          pnlPercent,
          size: position.size,
          success: true,
          orderId: 'DRY_RUN',
        });
      }
      return;
    }

    if (!this.trader) {
      console.log(`  [Error] Trader not available`);
      if (this.notifier) {
        await this.notifier.notifyRiskTrigger({
          type: triggerType as 'STOP_LOSS' | 'TAKE_PROFIT',
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          pnlPercent,
          size: position.size,
          success: false,
          error: 'Trader not available',
        });
      }
      return;
    }

    try {
      // Cancel any SL/TP protection orders before selling
      const { stopLossOrderId, takeProfitOrderId } = this.stateManager.getProtectionOrders(position.asset);
      const orderIds = [stopLossOrderId, takeProfitOrderId].filter(Boolean) as string[];
      if (orderIds.length > 0 && this.trader) {
        console.log(`  Cancelling ${orderIds.length} protection order(s)...`);
        await this.trader.cancelOrders(orderIds);
        this.stateManager.clearProtectionOrders(position.asset);
      }

      // Get current bid price for selling
      const spread = await this.clobApi.getSpread(position.asset);
      const sellPrice = Math.max(0.01, parseFloat(spread.bid || '0.5'));

      // Use dedicated sellPosition method (passes shares correctly, uses FAK)
      const result = await this.trader.sellPosition(
        position.asset,
        position.size,
        sellPrice,
        position.title,
      );

      if (result.success) {
        console.log(`  ✅ ${reason} executed - Order ID: ${result.orderId}`);
        this.stateManager.updatePosition(position.asset, -position.size, sellPrice);

        // Send success notification
        if (this.notifier) {
          await this.notifier.notifyRiskTrigger({
            type: triggerType as 'STOP_LOSS' | 'TAKE_PROFIT',
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            currentPrice,
            pnlPercent,
            size: position.size,
            success: true,
            orderId: result.orderId,
          });
        }
      } else {
        console.log(`  ❌ ${reason} failed: ${result.error}`);

        // "not enough balance" on SELL = ghost position (we don't own these tokens)
        if (result.error && (result.error.includes('not enough balance') || result.error.includes('not enough allowance'))) {
          console.log(`  Removing ghost position (we don't own these tokens)`);
          this.stateManager.updatePosition(position.asset, -position.size, currentPrice);
        }

        // Send failure notification
        if (this.notifier) {
          await this.notifier.notifyRiskTrigger({
            type: triggerType as 'STOP_LOSS' | 'TAKE_PROFIT',
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            currentPrice,
            pnlPercent,
            size: position.size,
            success: false,
            error: result.error,
          });
        }
      }
    } catch (error: any) {
      errorLogger.logError('RiskManager.sellPosition', error, { reason, asset: position.asset?.slice(0, 30), pnlPercent });
      console.log(`  ❌ ${reason} error: ${error?.message || error}`);

      // Send error notification
      if (this.notifier) {
        await this.notifier.notifyRiskTrigger({
          type: triggerType as 'STOP_LOSS' | 'TAKE_PROFIT',
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          pnlPercent,
          size: position.size,
          success: false,
          error: error?.message || 'Unknown error',
        });
      }
    }
  }
}
