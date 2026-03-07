import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { TelegramNotifier } from './notifier.js';
import { ClobApiClient } from '../api/clobApi.js';
import { errorLogger } from './errorLogger.js';

export interface WatchdogConfig {
  checkIntervalMs: number; // How often to run (default: 60000 = 1 min)
  stopLossPercent: number; // e.g., -50
  takeProfitPercent: number; // e.g., 200
}

interface PositionHealth {
  asset: string;
  title: string;
  status: 'healthy' | 'tp_missing' | 'tp_replaced' | 'sl_triggered' | 'price_error';
  detail: string;
}

export class PositionWatchdog {
  private config: WatchdogConfig;
  private stateManager: StateManager;
  private trader: Trader;
  private notifier: TelegramNotifier | null;
  private clobApi: ClobApiClient;
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private consecutiveErrors = 0;
  // Cache of open order IDs from the exchange (refreshed each cycle)
  private exchangeOrderIds: Set<string> = new Set();

  constructor(
    config: WatchdogConfig,
    stateManager: StateManager,
    trader: Trader,
    notifier: TelegramNotifier | null = null,
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.trader = trader;
    this.notifier = notifier;
    this.clobApi = new ClobApiClient();
  }

  start(): void {
    if (this.interval) return;

    console.log(`[Watchdog] Starting position watchdog`);
    console.log(`  Interval: ${this.config.checkIntervalMs / 1000}s`);
    console.log(`  SL: ${this.config.stopLossPercent}% | TP: +${this.config.takeProfitPercent}%`);

    this.interval = setInterval(() => this.runCheck(), this.config.checkIntervalMs);

    // First check after 15s (let other systems initialize first)
    setTimeout(() => this.runCheck(), 15_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[Watchdog] Stopped');
    }
  }

  updateConfig(config: Partial<WatchdogConfig>): void {
    if (config.stopLossPercent !== undefined) this.config.stopLossPercent = config.stopLossPercent;
    if (config.takeProfitPercent !== undefined) this.config.takeProfitPercent = config.takeProfitPercent;
  }

  private async runCheck(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const positions = this.stateManager.getAllPositions().filter(p => p.size > 0.001);
      if (positions.length === 0) {
        this.isProcessing = false;
        return;
      }

      // Fetch all open orders from exchange once per cycle
      const openOrders = await this.trader.getOpenOrders();
      this.exchangeOrderIds = new Set(
        openOrders.map((o: any) => o.id || o.orderID || o.order_id).filter(Boolean)
      );

      const results: PositionHealth[] = [];
      let tpReplaced = 0;

      for (const pos of positions) {
        const health = await this.checkPosition(pos);
        results.push(health);
        if (health.status === 'tp_replaced') tpReplaced++;
      }

      // Log summary (only when there are issues or every 10 cycles)
      const issues = results.filter(r => r.status !== 'healthy');
      if (issues.length > 0) {
        console.log(`[Watchdog] ${positions.length} positions checked | ${issues.length} issue(s):`);
        for (const issue of issues) {
          console.log(`  [${issue.status}] ${issue.title?.slice(0, 40)} | ${issue.detail}`);
        }
      }

      // Notify on Telegram if we had to replace TP orders
      if (tpReplaced > 0 && this.notifier) {
        await this.notifier.notify(
          `<b>Watchdog:</b> Replaced ${tpReplaced} missing TP order(s) on ${positions.length} positions`
        );
      }

      this.consecutiveErrors = 0;
    } catch (error: any) {
      this.consecutiveErrors++;
      errorLogger.logError('Watchdog', error, { consecutiveErrors: this.consecutiveErrors });
      // Only log to console every 5th consecutive error to avoid spam
      if (this.consecutiveErrors <= 3 || this.consecutiveErrors % 5 === 0) {
        console.error(`[Watchdog] Check failed (${this.consecutiveErrors}x):`, error?.message);
      }
      // Alert on Telegram if 5 consecutive failures
      if (this.consecutiveErrors === 5 && this.notifier) {
        await this.notifier.notify(
          `<b>Watchdog ALERT:</b> 5 consecutive check failures. Last error: ${error?.message}`
        );
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async checkPosition(
    pos: { asset: string; size: number; title: string; outcome: string; avgPrice: number; slug: string; entryTime: number }
  ): Promise<PositionHealth> {
    const label = pos.title?.slice(0, 40) || pos.asset.slice(0, 20);

    // 1. Check if TP order is still on the exchange
    const { takeProfitOrderId } = this.stateManager.getProtectionOrders(pos.asset);

    if (takeProfitOrderId && !this.exchangeOrderIds.has(takeProfitOrderId)) {
      // TP order was on exchange but is now gone (cancelled externally, expired, or filled)
      // Clear stale ID and re-place
      this.stateManager.clearProtectionOrders(pos.asset);

      const replaced = await this.replaceTPOrder(pos);
      if (replaced) {
        return { asset: pos.asset, title: label, status: 'tp_replaced', detail: 'TP order missing from exchange, replaced' };
      }
      return { asset: pos.asset, title: label, status: 'tp_missing', detail: 'TP order missing, failed to replace' };
    }

    if (!takeProfitOrderId) {
      // No TP order ID saved at all — place one
      const replaced = await this.replaceTPOrder(pos);
      if (replaced) {
        return { asset: pos.asset, title: label, status: 'tp_replaced', detail: 'No TP order found, placed new one' };
      }
      return { asset: pos.asset, title: label, status: 'tp_missing', detail: 'No TP order, failed to place' };
    }

    // 2. Verify current price for stop loss (redundant safety net)
    try {
      const spread = await this.clobApi.getSpread(pos.asset);
      const mid = (parseFloat(spread.bid) + parseFloat(spread.ask)) / 2;
      // Skip resolved markets / empty orderbooks
      if (mid > 0.02 && pos.avgPrice > 0) {
        const pnl = ((mid - pos.avgPrice) / pos.avgPrice) * 100;

        // If SL should have triggered but somehow didn't, log it as urgent
        // (RiskManager should catch this, this is the safety net)
        if (pnl <= this.config.stopLossPercent) {
          console.error(`[Watchdog] SL SHOULD BE TRIGGERED: ${label} | P&L: ${pnl.toFixed(1)}% (limit: ${this.config.stopLossPercent}%)`);
          return { asset: pos.asset, title: label, status: 'sl_triggered', detail: `P&L ${pnl.toFixed(1)}% below SL ${this.config.stopLossPercent}%` };
        }
      }
    } catch {
      return { asset: pos.asset, title: label, status: 'price_error', detail: 'Could not fetch price' };
    }

    return { asset: pos.asset, title: label, status: 'healthy', detail: 'OK' };
  }

  private async replaceTPOrder(
    pos: { asset: string; size: number; avgPrice: number; title: string }
  ): Promise<boolean> {
    try {
      const tpPercent = this.config.takeProfitPercent / 100;
      const takeProfitPrice = Math.min(0.99, Math.round((pos.avgPrice * (1 + tpPercent)) * 100) / 100);

      // Skip if TP price is not above entry
      if (takeProfitPrice <= pos.avgPrice) return false;

      // Update balance allowance before placing GTC sell
      await this.trader.updateBalanceAllowance();

      const result = await this.trader.placeLimitOrder(pos.asset, 'SELL', pos.size, takeProfitPrice);
      if (result.success && result.orderId) {
        this.stateManager.setProtectionOrders(pos.asset, undefined, result.orderId);
        return true;
      }
      return false;
    } catch (err: any) {
      errorLogger.logError('Watchdog.replaceTP', err, { asset: pos.asset.slice(0, 30), title: pos.title?.slice(0, 30) });
      console.error(`[Watchdog] Failed to replace TP for ${pos.title?.slice(0, 30)}: ${err?.message}`);
      return false;
    }
  }
}
