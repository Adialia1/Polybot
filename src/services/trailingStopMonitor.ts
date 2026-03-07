import { EventEmitter } from 'events';
import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { TelegramNotifier } from './notifier.js';
import { ClobApiClient } from '../api/clobApi.js';
import { MarketWebSocket } from '../api/websocket.js';
import { errorLogger } from './errorLogger.js';

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
  private ws: MarketWebSocket | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private dryRun: boolean;
  private isProcessing = false;
  // Track latest prices from WebSocket for faster checks
  private latestPrices: Map<string, number> = new Map();

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
      checkIntervalMs: config.checkIntervalMs || 30000, // Default 30s (was 60s)
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

    // Start WebSocket for real-time price updates
    this.startWebSocket();

    this.checkInterval = setInterval(() => {
      this.checkPositions();
    }, this.config.checkIntervalMs);

    // Run immediately on start
    this.checkPositions();
  }

  /**
   * Start WebSocket connection for real-time price updates on held positions
   */
  private async startWebSocket(): Promise<void> {
    try {
      this.ws = new MarketWebSocket();
      await this.ws.connect();

      // Subscribe to price updates for current positions
      const positions = this.stateManager.getAllPositions();
      if (positions.length > 0) {
        const assetIds = positions.map(p => p.asset);
        this.ws.subscribeToAssets(assetIds);
        console.log(`[TrailingStop] WebSocket subscribed to ${assetIds.length} position prices`);
      }

      // Listen for price changes
      this.ws.on('last_trade_price', (event: any) => {
        const price = parseFloat(event.price);
        if (price > 0 && event.asset_id) {
          this.latestPrices.set(event.asset_id, price);
        }
      });

      this.ws.on('price_change', (event: any) => {
        const price = parseFloat(event.price);
        if (price > 0 && event.asset_id) {
          this.latestPrices.set(event.asset_id, price);
        }
      });
    } catch (error) {
      console.error('[TrailingStop] WebSocket connection failed, falling back to polling:', error);
      // Continue with polling only - not critical
    }
  }

  /**
   * Update WebSocket subscriptions when positions change
   */
  updateSubscriptions(): void {
    if (!this.ws) return;

    const positions = this.stateManager.getAllPositions();
    if (positions.length > 0) {
      const assetIds = positions.map(p => p.asset);
      this.ws.subscribeToAssets(assetIds);
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }

    this.latestPrices.clear();
    console.log('[TrailingStop] Stopped');
  }

  /**
   * Update configuration (for hot-reload support)
   */
  updateConfig(newConfig: Partial<TrailingStopConfig>): void {
    if (newConfig.trailingStopPercent !== undefined) {
      this.config.trailingStopPercent = newConfig.trailingStopPercent;
      console.log(`[TrailingStop] Updated trailingStopPercent to ${newConfig.trailingStopPercent}%`);
    }

    if (newConfig.checkIntervalMs !== undefined && newConfig.checkIntervalMs !== this.config.checkIntervalMs) {
      this.config.checkIntervalMs = newConfig.checkIntervalMs;
      console.log(`[TrailingStop] Updated checkIntervalMs to ${newConfig.checkIntervalMs}ms`);

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
          // Try WebSocket price first (real-time), fall back to REST API midpoint
          let currentPrice = this.latestPrices.get(position.asset) || 0;

          if (currentPrice === 0) {
            // Fall back to REST API - use midpoint for more stable price
            // (raw bid can be $0.01 on thin/resolved markets)
            const spread = await this.clobApi.getSpread(position.asset);
            const bid = parseFloat(spread.bid || '0');
            const ask = parseFloat(spread.ask || '0');
            currentPrice = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid;
          }

          // Skip if price is effectively zero (resolved market or empty orderbook)
          if (currentPrice <= 0.02 || position.avgPrice === 0) continue;

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
            console.log(`\n[TrailingStop] TRAILING STOP TRIGGERED:`);
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
        } catch (error: any) {
          // Log errors instead of silently swallowing
          errorLogger.logError('TrailingStop.checkPosition', error, { asset: position.asset?.slice(0, 30), title: position.title?.slice(0, 40) });
          console.error(`[TrailingStop] Error checking ${position.title || position.asset.slice(0, 20)}:`, error?.message || error);
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
      // Cancel any SL/TP protection orders before selling
      const { stopLossOrderId, takeProfitOrderId } = this.stateManager.getProtectionOrders(position.asset);
      const orderIds = [stopLossOrderId, takeProfitOrderId].filter(Boolean) as string[];
      if (orderIds.length > 0 && this.trader) {
        console.log(`  Cancelling ${orderIds.length} protection order(s)...`);
        await this.trader.cancelOrders(orderIds);
        this.stateManager.clearProtectionOrders(position.asset);
      }

      // Use the dedicated sellPosition method on Trader
      // Pass shares directly (not USD value)
      const result = await this.trader.sellPosition(
        position.asset,
        position.size,
        currentPrice,
        position.title,
      );

      if (result.success) {
        console.log(`  Trailing stop executed - Order ID: ${result.orderId}`);
        console.log(`  P&L from entry: ${pnlFromEntry >= 0 ? '+' : ''}${pnlFromEntry.toFixed(1)}%`);

        // Update position state (remove it)
        this.stateManager.updatePosition(position.asset, -position.size, currentPrice);

        // Update daily P&L
        const realizedPnL = (currentPrice - position.avgPrice) * position.size;
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
        console.log(`  Trailing stop failed: ${result.error}`);

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
      errorLogger.logError('TrailingStop.sellPosition', error, { asset: position.asset?.slice(0, 30) });
      console.error(`  Trailing stop error: ${error?.message || error}`);

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
<b>Trailing Stop Triggered</b>

<b>Market:</b> ${data.title}
<b>Outcome:</b> ${data.outcome}
<b>Entry Price:</b> $${data.entryPrice.toFixed(3)}
<b>Peak Price:</b> $${data.highestPrice.toFixed(3)}
<b>Current Price:</b> $${data.currentPrice.toFixed(3)}
<b>Drop from Peak:</b> ${data.dropPercent.toFixed(1)}%
<b>P&L from Entry:</b> ${pnlSign}${data.pnlPercent.toFixed(1)}%
<b>Size:</b> ${data.size.toFixed(4)} shares

${data.success ? 'Position sold' : 'FAILED'} ${statusLine}
`.trim();

    await this.notifier.notify(message);
  }
}
