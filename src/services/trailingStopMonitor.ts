import { EventEmitter } from 'events';
import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { TelegramNotifier } from './notifier.js';
import { ClobApiClient } from '../api/clobApi.js';

export interface TrailingStopConfig {
  // Trailing stop percentage (e.g., 15 = sell if price drops 15% from peak)
  trailingStopPercent: number;

  // How often to check prices (ms)
  checkIntervalMs: number;
}

export interface TrailingStopTrigger {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  highestPrice: number;
  currentPrice: number;
  dropPercent: number;
}

export class TrailingStopMonitor extends EventEmitter {
  private config: TrailingStopConfig;
  private stateManager: StateManager;
  private trader: Trader | null;
  private notifier: TelegramNotifier | null;
  private clobApi: ClobApiClient;
  private checkInterval: NodeJS.Timeout | null = null;
  private dryRun: boolean;
  private isProcessing = false;

  constructor(
    config: TrailingStopConfig,
    stateManager: StateManager,
    trader: Trader | null,
    dryRun: boolean = true,
    notifier: TelegramNotifier | null = null
  ) {
    super();
    this.config = {
      trailingStopPercent: config.trailingStopPercent,
      checkIntervalMs: config.checkIntervalMs || 60000,
    };
    this.stateManager = stateManager;
    this.trader = trader;
    this.notifier = notifier;
    this.clobApi = new ClobApiClient();
    this.dryRun = dryRun;
  }

  /**
   * Start monitoring positions for trailing stop
   */
  startMonitoring(): void {
    if (this.checkInterval) return;

    if (this.config.trailingStopPercent <= 0) {
      console.log('[TrailingStop] Disabled (TRAILING_STOP_PERCENT <= 0)');
      return;
    }

    console.log(`[TrailingStop] Starting trailing stop monitor`);
    console.log(`  Trailing Stop: ${this.config.trailingStopPercent}% from peak`);
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
      console.log('[TrailingStop] Stopped');
    }
  }

  /**
   * Check all positions for trailing stop conditions
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

      for (const position of positions) {
        try {
          // Get current price (use bid as it's what we'd get when selling)
          const spread = await this.clobApi.getSpread(position.asset);
          const currentPrice = parseFloat(spread.bid || '0');

          if (currentPrice === 0 || position.avgPrice === 0) continue;

          // Update highest price if applicable
          const wasUpdated = this.stateManager.updateHighestPrice(position.asset, currentPrice);
          if (wasUpdated) {
            console.log(`[TrailingStop] New high for ${position.outcome}: $${currentPrice.toFixed(3)} (entry: $${position.avgPrice.toFixed(3)})`);
          }

          // Check if trailing stop should trigger
          const check = this.stateManager.checkTrailingStop(
            position.asset,
            currentPrice,
            this.config.trailingStopPercent
          );

          if (check.triggered) {
            console.log(`\n📉 TRAILING STOP TRIGGERED:`);
            console.log(`  ${position.title} - ${position.outcome}`);
            console.log(`  Entry: $${position.avgPrice.toFixed(3)}`);
            console.log(`  Peak: $${check.highestPrice!.toFixed(3)}`);
            console.log(`  Current: $${currentPrice.toFixed(3)}`);
            console.log(`  Drop from peak: ${check.dropPercent!.toFixed(1)}% (threshold: ${this.config.trailingStopPercent}%)`);

            // Emit event for any listeners
            const trigger: TrailingStopTrigger = {
              asset: position.asset,
              title: position.title,
              outcome: position.outcome,
              size: position.size,
              avgPrice: position.avgPrice,
              highestPrice: check.highestPrice!,
              currentPrice,
              dropPercent: check.dropPercent!,
            };
            this.emit('trailingStopTriggered', trigger);

            // Execute the sell
            await this.sellPosition(position, currentPrice, check.highestPrice!, check.dropPercent!);
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
   * Execute trailing stop sell for a position
   */
  private async sellPosition(
    position: { asset: string; size: number; title: string; outcome: string; avgPrice: number },
    currentPrice: number,
    highestPrice: number,
    dropPercent: number
  ): Promise<void> {
    // Calculate P&L from entry (not from peak)
    const pnlFromEntry = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;

    if (this.dryRun) {
      console.log(`  [DRY RUN] Would sell ${position.size.toFixed(4)} shares`);
      console.log(`  P&L from entry: ${pnlFromEntry >= 0 ? '+' : ''}${pnlFromEntry.toFixed(1)}%`);

      // Still send notification for dry run
      if (this.notifier) {
        await this.notifyTrailingStop({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          highestPrice,
          currentPrice,
          dropPercent,
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
        await this.notifyTrailingStop({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          highestPrice,
          currentPrice,
          dropPercent,
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
        console.log(`  ✅ Trailing stop executed - Order ID: ${result.orderId}`);
        console.log(`  P&L from entry: ${pnlFromEntry >= 0 ? '+' : ''}${pnlFromEntry.toFixed(1)}%`);

        // Update position state (remove it)
        this.stateManager.updatePosition(position.asset, -position.size, sellPrice);

        // Update daily P&L
        const realizedPnL = (sellPrice - position.avgPrice) * position.size;
        this.stateManager.updateDailyPnL(realizedPnL);

        // Send success notification
        if (this.notifier) {
          await this.notifyTrailingStop({
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            highestPrice,
            currentPrice,
            dropPercent,
            pnlPercent: pnlFromEntry,
            size: position.size,
            success: true,
            orderId: result.orderId,
          });
        }
      } else {
        console.log(`  ❌ Trailing stop failed: ${result.error}`);

        // Send failure notification
        if (this.notifier) {
          await this.notifyTrailingStop({
            title: position.title,
            outcome: position.outcome,
            entryPrice: position.avgPrice,
            highestPrice,
            currentPrice,
            dropPercent,
            pnlPercent: pnlFromEntry,
            size: position.size,
            success: false,
            error: result.error,
          });
        }
      }
    } catch (error: any) {
      console.log(`  ❌ Trailing stop error: ${error?.message || error}`);

      // Send error notification
      if (this.notifier) {
        await this.notifyTrailingStop({
          title: position.title,
          outcome: position.outcome,
          entryPrice: position.avgPrice,
          highestPrice,
          currentPrice,
          dropPercent,
          pnlPercent: pnlFromEntry,
          size: position.size,
          success: false,
          error: error?.message || 'Unknown error',
        });
      }
    }
  }

  /**
   * Send Telegram notification for trailing stop trigger
   */
  private async notifyTrailingStop(data: {
    title: string;
    outcome: string;
    entryPrice: number;
    highestPrice: number;
    currentPrice: number;
    dropPercent: number;
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
📉 <b>Trailing Stop Triggered</b>

<b>Market:</b> ${data.title}
<b>Outcome:</b> ${data.outcome}
<b>Entry Price:</b> $${data.entryPrice.toFixed(3)}
<b>Peak Price:</b> $${data.highestPrice.toFixed(3)}
<b>Current Price:</b> $${data.currentPrice.toFixed(3)}
<b>Drop from Peak:</b> ${data.dropPercent.toFixed(1)}%
<b>P&L from Entry:</b> ${pnlSign}${data.pnlPercent.toFixed(1)}%
<b>Size:</b> ${data.size.toFixed(4)} shares

${data.success ? '✅' : '❌'} ${statusLine}
`.trim();

    await this.notifier.notify(message);
  }
}
