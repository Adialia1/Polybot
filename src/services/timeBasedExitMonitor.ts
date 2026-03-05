import { EventEmitter } from 'events';
import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { TelegramNotifier } from './notifier.js';
import { ClobApiClient } from '../api/clobApi.js';

export interface TimeBasedExitConfig {
  // Max hours to hold a position (e.g., 48 = sell if held longer than 48 hours)
  maxHoldTimeHours: number;

  // How often to check positions (ms) - default 5 minutes
  checkIntervalMs: number;
}

export interface TimeBasedExitTrigger {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  entryTime: number;
  holdTimeHours: number;
  maxHoldTimeHours: number;
  currentPrice: number;
}

export class TimeBasedExitMonitor extends EventEmitter {
  private config: TimeBasedExitConfig;
  private stateManager: StateManager;
  private trader: Trader | null;
  private notifier: TelegramNotifier | null;
  private clobApi: ClobApiClient;
  private checkInterval: NodeJS.Timeout | null = null;
  private dryRun: boolean;
  private isProcessing = false;

  constructor(
    config: TimeBasedExitConfig,
    stateManager: StateManager,
    trader: Trader | null,
    dryRun: boolean = true,
    notifier: TelegramNotifier | null = null
  ) {
    super();
    this.config = {
      maxHoldTimeHours: config.maxHoldTimeHours,
      checkIntervalMs: config.checkIntervalMs || 5 * 60 * 1000, // Default 5 minutes
    };
    this.stateManager = stateManager;
    this.trader = trader;
    this.notifier = notifier;
    this.clobApi = new ClobApiClient();
    this.dryRun = dryRun;
  }

  /**
   * Format hold time in human-readable format (e.g., "52h 15m")
   */
  private formatHoldTime(holdTimeMs: number): string {
    const totalMinutes = Math.floor(holdTimeMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  /**
   * Start monitoring positions for time-based exits
   */
  startMonitoring(): void {
    if (this.checkInterval) return;

    if (this.config.maxHoldTimeHours <= 0) {
      console.log('[TimeBasedExit] Disabled (MAX_HOLD_TIME_HOURS <= 0)');
      return;
    }

    console.log(`[TimeBasedExit] Starting time-based exit monitor`);
    console.log(`  Max Hold Time: ${this.config.maxHoldTimeHours}h`);
    console.log(`  Check Interval: ${this.config.checkIntervalMs / 1000}s`);

    this.checkInterval = setInterval(() => {
      this.checkPositions();
    }, this.config.checkIntervalMs);

    // Run immediately on start
    this.checkPositions();
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[TimeBasedExit] Stopped');
    }
  }

  /**
   * Update configuration (for hot-reload support)
   */
  updateConfig(newConfig: Partial<TimeBasedExitConfig>): void {
    if (newConfig.maxHoldTimeHours !== undefined) {
      this.config.maxHoldTimeHours = newConfig.maxHoldTimeHours;
      console.log(`[TimeBasedExit] Updated maxHoldTimeHours to ${newConfig.maxHoldTimeHours}h`);
    }

    if (newConfig.checkIntervalMs !== undefined && newConfig.checkIntervalMs !== this.config.checkIntervalMs) {
      this.config.checkIntervalMs = newConfig.checkIntervalMs;
      console.log(`[TimeBasedExit] Updated checkIntervalMs to ${newConfig.checkIntervalMs}ms`);

      // Restart the interval with new timing
      if (this.checkInterval) {
        this.stopMonitoring();
        this.startMonitoring();
      }
    }
  }

  /**
   * Update dry run mode
   */
  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }

  /**
   * Check all positions for time-based exit conditions
   */
  private async checkPositions(): Promise<void> {
    // Prevent concurrent checks
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const positions = this.stateManager.getAllPositions();
      if (positions.length === 0) {
        this.isProcessing = false;
        return;
      }

      const maxHoldTimeMs = this.config.maxHoldTimeHours * 60 * 60 * 1000;
      const now = Date.now();

      for (const position of positions) {
        try {
          const holdTimeMs = now - position.entryTime;

          // Check if position has exceeded max hold time
          if (holdTimeMs > maxHoldTimeMs) {
            const holdTimeHours = holdTimeMs / (1000 * 60 * 60);
            const holdTimeFormatted = this.formatHoldTime(holdTimeMs);
            const maxHoldTimeFormatted = `${this.config.maxHoldTimeHours}h`;

            console.log(`\n[TimeBasedExit] TIME LIMIT EXCEEDED:`);
            console.log(`  ${position.title} - ${position.outcome}`);
            console.log(`  Position held for ${holdTimeFormatted}, exceeds ${maxHoldTimeFormatted} limit`);
            console.log(`  Entry: $${position.avgPrice.toFixed(3)} at ${new Date(position.entryTime).toLocaleString()}`);

            // Get current price for the sell
            let currentPrice = 0.5; // Default fallback
            try {
              const spread = await this.clobApi.getSpread(position.asset);
              currentPrice = parseFloat(spread.bid || '0.5');
              console.log(`  Current Bid: $${currentPrice.toFixed(3)}`);
            } catch (error) {
              console.log(`  [Warning] Could not fetch current price, using default`);
            }

            // Emit event for any listeners
            const trigger: TimeBasedExitTrigger = {
              asset: position.asset,
              title: position.title,
              outcome: position.outcome,
              size: position.size,
              avgPrice: position.avgPrice,
              entryTime: position.entryTime,
              holdTimeHours,
              maxHoldTimeHours: this.config.maxHoldTimeHours,
              currentPrice,
            };
            this.emit('timeBasedExitTriggered', trigger);

            // Execute the sell
            await this.sellPosition(position, currentPrice, holdTimeMs);
          }
        } catch (error) {
          // Silently continue on individual position errors
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute time-based exit sell for a position
   */
  private async sellPosition(
    position: { asset: string; size: number; title: string; outcome: string; avgPrice: number; entryTime: number },
    currentPrice: number,
    holdTimeMs: number
  ): Promise<void> {
    // Calculate P&L from entry
    const pnlFromEntry = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
    const holdTimeFormatted = this.formatHoldTime(holdTimeMs);

    if (this.dryRun) {
      console.log(`  [DRY RUN] Would sell ${position.size.toFixed(4)} shares`);
      console.log(`  P&L from entry: ${pnlFromEntry >= 0 ? '+' : ''}${pnlFromEntry.toFixed(1)}%`);

      // Still send notification for dry run
      if (this.notifier) {
        await this.notifyTimeBasedExit({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          holdTime: holdTimeFormatted,
          maxHoldTime: `${this.config.maxHoldTimeHours}h`,
          pnlPercent: pnlFromEntry,
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
        await this.notifyTimeBasedExit({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          holdTime: holdTimeFormatted,
          maxHoldTime: `${this.config.maxHoldTimeHours}h`,
          pnlPercent: pnlFromEntry,
          size: position.size,
          success: false,
          error: 'Trader not available',
        });
      }
      return;
    }

    try {
      // Get current bid price for selling
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
        console.log(`  [TimeBasedExit] Position sold - Order ID: ${result.orderId}`);
        console.log(`  P&L from entry: ${pnlFromEntry >= 0 ? '+' : ''}${pnlFromEntry.toFixed(1)}%`);

        // Update position state (remove it)
        this.stateManager.updatePosition(position.asset, -position.size, sellPrice);

        // Update daily P&L
        const realizedPnL = (sellPrice - position.avgPrice) * position.size;
        this.stateManager.updateDailyPnL(realizedPnL);

        // Send success notification
        if (this.notifier) {
          await this.notifyTimeBasedExit({
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            currentPrice: sellPrice,
            holdTime: holdTimeFormatted,
            maxHoldTime: `${this.config.maxHoldTimeHours}h`,
            pnlPercent: pnlFromEntry,
            size: position.size,
            success: true,
            orderId: result.orderId,
          });
        }
      } else {
        console.log(`  [TimeBasedExit] Failed to sell: ${result.error}`);

        // Send failure notification
        if (this.notifier) {
          await this.notifyTimeBasedExit({
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            currentPrice,
            holdTime: holdTimeFormatted,
            maxHoldTime: `${this.config.maxHoldTimeHours}h`,
            pnlPercent: pnlFromEntry,
            size: position.size,
            success: false,
            error: result.error,
          });
        }
      }
    } catch (error: any) {
      console.log(`  [TimeBasedExit] Error: ${error?.message || error}`);

      // Send error notification
      if (this.notifier) {
        await this.notifyTimeBasedExit({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          currentPrice,
          holdTime: holdTimeFormatted,
          maxHoldTime: `${this.config.maxHoldTimeHours}h`,
          pnlPercent: pnlFromEntry,
          size: position.size,
          success: false,
          error: error?.message || 'Unknown error',
        });
      }
    }
  }

  /**
   * Send Telegram notification for time-based exit trigger
   */
  private async notifyTimeBasedExit(data: {
    title: string;
    outcome: string;
    entryPrice: number;
    currentPrice: number;
    holdTime: string;
    maxHoldTime: string;
    pnlPercent: number;
    size: number;
    success: boolean;
    orderId?: string;
    error?: string;
  }): Promise<void> {
    if (!this.notifier || !this.notifier.isEnabled()) return;

    const pnlSign = data.pnlPercent >= 0 ? '+' : '';
    const statusLine = data.success
      ? `Position sold successfully${data.orderId ? ` (Order: ${data.orderId})` : ''}`
      : `Failed to sell: ${data.error}`;

    const message = `
[TimeBasedExit] <b>Max Hold Time Exceeded</b>

<b>Market:</b> ${data.title}
<b>Outcome:</b> ${data.outcome}
<b>Entry Price:</b> $${data.entryPrice.toFixed(3)}
<b>Current Price:</b> $${data.currentPrice.toFixed(3)}
<b>Hold Time:</b> ${data.holdTime} (limit: ${data.maxHoldTime})
<b>P&L from Entry:</b> ${pnlSign}${data.pnlPercent.toFixed(1)}%
<b>Size:</b> ${data.size.toFixed(4)} shares

${data.success ? '[OK]' : '[FAILED]'} ${statusLine}
`.trim();

    await this.notifier.notify(message);
  }
}
