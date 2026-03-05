import 'dotenv/config';
import { TradeMonitor } from './services/tradeMonitor.js';
import { PositionSizer } from './services/positionSizer.js';
import { PositionManager } from './services/positionManager.js';
import { OrderQueue, QueuedOrder } from './services/orderQueue.js';
import { StateManager } from './services/stateManager.js';
import { PositionReconciler } from './services/positionReconciler.js';
import { Trader } from './services/trader.js';
import { ClobApiClient } from './api/clobApi.js';
import { loadConfig } from './config.js';
import { TradeSignal, WalletConfig, Trade } from './types/index.js';

export class CopyTradingBot {
  private config = loadConfig();
  private monitor: TradeMonitor | null = null;
  private positionSizer: PositionSizer;
  private positionManager: PositionManager | null = null;
  private orderQueue: OrderQueue;
  private stateManager: StateManager;
  private reconciler: PositionReconciler | null = null;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private trader: Trader | null = null;
  private clobApi: ClobApiClient;
  private isRunning = false;

  constructor() {
    this.clobApi = new ClobApiClient();

    // Initialize state manager (loads persisted state)
    this.stateManager = new StateManager();

    this.positionSizer = new PositionSizer({
      userAccountSize: this.config.userAccountSize,
      maxPositionSize: this.config.maxPositionSize,
      minTradeSize: this.config.minTradeSize,
      maxPercentage: this.config.maxPercentagePerTrade,
    });

    this.orderQueue = new OrderQueue({
      maxConcurrent: 1,
      orderDelayMs: 1000,
    });

    // Handle order processing
    this.orderQueue.on('process', (order: QueuedOrder) => {
      this.executeOrder(order);
    });
  }

  async start(): Promise<void> {
    console.log('='.repeat(50));
    console.log('  Polymarket Trade Copier Bot');
    console.log('='.repeat(50));

    if (this.config.wallets.length === 0) {
      console.log('\nNo wallets configured to track.');
      return;
    }

    // Start state auto-save
    this.stateManager.startAutoSave(30000);

    // Print recovered state
    const stats = this.stateManager.getStats();
    if (stats.totalTrades > 0) {
      console.log(`\n📊 Recovered State:`);
      console.log(`  Total trades: ${stats.totalTrades}`);
      console.log(`  Successful: ${stats.successfulTrades}`);
      console.log(`  Failed: ${stats.failedTrades}`);
      console.log(`  Volume: $${stats.totalVolume.toFixed(2)}`);
      console.log(`  Running since: ${new Date(stats.startTime).toLocaleString()}`);
    }

    // Initialize position manager if we have a funder address
    if (this.config.funderAddress) {
      this.positionManager = new PositionManager({
        proxyWallet: this.config.funderAddress,
        syncIntervalMs: 30000,
      });
      await this.positionManager.initialize();

      // Sync state manager with API positions
      const apiPositions = this.positionManager.getPositions();
      this.stateManager.syncPositionsFromApi(apiPositions);

      this.positionManager.printPositions();
    }

    // Initialize trader if trading is enabled
    if (this.config.enableTrading) {
      if (!this.config.privateKey) {
        console.error('\n❌ Trading enabled but PRIVATE_KEY not set!');
        return;
      }

      const apiCredentials = process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE
        ? {
            key: process.env.POLY_API_KEY,
            secret: process.env.POLY_API_SECRET,
            passphrase: process.env.POLY_PASSPHRASE,
          }
        : undefined;

      this.trader = new Trader({
        privateKey: this.config.privateKey,
        funderAddress: this.config.funderAddress,
        dryRun: this.config.dryRun,
        apiCredentials,
      });

      try {
        await this.trader.initialize();
      } catch (err) {
        console.error('Failed to initialize trader:', err);
        return;
      }

      // Initialize reconciler
      this.reconciler = new PositionReconciler({
        stateManager: this.stateManager,
        trader: this.trader,
        trackedWallets: this.config.wallets,
        dryRun: this.config.dryRun,
      });

      // Run position reconciliation on startup
      // This detects if traders sold while we were offline
      if (this.stateManager.getAllPositions().length > 0) {
        console.log('\n🔄 Running position reconciliation...');
        try {
          await this.reconciler.reconcile();
        } catch (err) {
          console.error('Reconciliation failed:', err);
          // Continue anyway - don't block startup
        }
      }

      // Start periodic reconciliation (every hour)
      this.reconcileInterval = setInterval(async () => {
        if (this.stateManager.getAllPositions().length > 0) {
          console.log('\n🔄 Running periodic reconciliation...');
          try {
            await this.reconciler!.reconcile();
          } catch (err) {
            console.error('Periodic reconciliation failed:', err);
          }
        }
      }, 60 * 60 * 1000); // Every hour
      console.log('[Reconciler] Periodic check enabled (every 1h)');
    }

    // Initialize trade monitor
    this.monitor = new TradeMonitor({
      wallets: this.config.wallets,
      pollingIntervalMs: this.config.pollingIntervalMs,
    });

    // Handle new trade signals
    this.monitor.on('trade', (signal: TradeSignal, wallet: WalletConfig) => {
      this.handleTradeSignal(signal, wallet);
    });

    this.monitor.on('error', ({ wallet, error }) => {
      console.error(`[Error] ${wallet.alias}:`, error);
    });

    // Start order queue
    this.orderQueue.start();

    // Start monitoring
    console.log('\nStarting trade monitor...');
    await this.monitor.start();

    this.isRunning = true;
    this.printStatus();

    console.log('\nWaiting for new trades... (Ctrl+C to stop)\n');
  }

  private async handleTradeSignal(signal: TradeSignal, wallet: WalletConfig): Promise<void> {
    const trade = signal.trade;
    const tradePrice = parseFloat(String(trade.price));

    // Filter by probability
    if (tradePrice < this.config.minProbability) {
      console.log(`[Filter] Skipped ${wallet.alias}'s trade: ${trade.outcome} @ $${trade.price} (prob too low)`);
      return;
    }
    if (tradePrice > this.config.maxProbability) {
      console.log(`[Filter] Skipped ${wallet.alias}'s trade: ${trade.outcome} @ $${trade.price} (prob too high)`);
      return;
    }

    // For SELL orders, check if we have the position
    if (trade.side === 'SELL') {
      const hasPosition = this.stateManager.hasPosition(trade.asset);
      const positionSize = this.stateManager.getPositionSize(trade.asset);

      if (!hasPosition || positionSize <= 0) {
        console.log(`[Skip] ${wallet.alias} sold ${trade.outcome} but we don't have this position`);
        return;
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`🚨 NEW TRADE SIGNAL from ${wallet.alias}`);
    console.log('='.repeat(50));

    const tradeTime = new Date(trade.timestamp * 1000);
    const delay = Date.now() - tradeTime.getTime();

    console.log(`Time: ${tradeTime.toLocaleTimeString()} (${(delay / 1000).toFixed(1)}s ago)`);
    console.log(`Market: ${trade.title}`);
    console.log(`Outcome: ${trade.outcome}`);
    console.log(`Side: ${trade.side}`);
    console.log(`Size: ${trade.size} shares`);
    console.log(`Price: $${trade.price} (${(tradePrice * 100).toFixed(1)}% probability)`);

    // Calculate position size
    let finalSize = 0;
    try {
      const sizing = await this.positionSizer.calculatePositionSize(trade, wallet.address);

      console.log(`\n📊 Position Sizing:`);
      console.log(`  Trader's trade: $${sizing.originalTradeValue.toFixed(2)}`);
      console.log(`  Trader's account: $${sizing.traderAccountSize.toFixed(2)}`);
      console.log(`  Trade %: ${sizing.tradePercentage.toFixed(3)}% of their account`);
      console.log(`  ─────────────────────`);
      console.log(`  Your account: $${sizing.yourAccountSize.toFixed(2)}`);
      console.log(`  Proportional: $${sizing.recommendedSize.toFixed(2)}`);
      console.log(`  Final size: $${sizing.cappedSize.toFixed(2)} (${sizing.reason})`);

      finalSize = sizing.cappedSize;

      if (sizing.cappedSize === 0) {
        console.log(`\n⏭️  Skipping trade (${sizing.reason})`);
        console.log('='.repeat(50) + '\n');
        return;
      }
    } catch (err) {
      console.log(`\n  [Could not calculate position size - skipping]`);
      console.log('='.repeat(50) + '\n');
      return;
    }

    // For SELL, adjust size to what we actually have
    if (trade.side === 'SELL' && this.positionManager) {
      const position = this.positionManager.getPosition(trade.asset);
      if (position) {
        // Sell proportionally - if trader sells 50%, we sell 50% of our position
        const traderSellRatio = parseFloat(String(trade.size)) / 100; // Approximate
        const ourSellSize = position.size * Math.min(traderSellRatio, 1);
        finalSize = ourSellSize * tradePrice; // Convert to USD value
        console.log(`  Adjusted sell: ${ourSellSize.toFixed(4)} shares ($${finalSize.toFixed(2)})`);
      }
    }

    // Add current market price
    try {
      const spread = await this.clobApi.getSpread(trade.asset);
      console.log(`\n💹 Current Market:`);
      console.log(`  Bid: $${spread.bid} | Ask: $${spread.ask} | Spread: $${spread.spread}`);
    } catch (err) {
      // Ignore
    }

    // Queue the order
    if (this.config.enableTrading && finalSize > 0) {
      this.orderQueue.enqueue(trade, wallet.alias, wallet.address, finalSize);
      console.log(`\n📋 Order queued`);
    } else if (!this.config.enableTrading) {
      console.log('\n📋 Trade ready to copy (trading disabled)');
    }

    console.log('='.repeat(50) + '\n');
  }

  private async executeOrder(order: QueuedOrder): Promise<void> {
    if (!this.trader) {
      this.orderQueue.failOrder(order.id, 'Trader not initialized');
      return;
    }

    console.log(`\n🔄 Executing order: ${order.id}`);
    console.log(`  ${order.trade.side} $${order.amount.toFixed(2)} on ${order.trade.outcome}`);

    // Record order in state
    this.stateManager.addOrder({
      id: order.id,
      asset: order.trade.asset,
      side: order.trade.side as 'BUY' | 'SELL',
      amount: order.amount,
      status: 'processing',
      createdAt: order.createdAt,
      walletAlias: order.walletAlias,
    });

    // Add delay if configured
    if (this.config.copyDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.copyDelayMs));
    }

    try {
      const result = await this.trader.copyTrade(order.trade, order.amount);

      if (result.success) {
        console.log(`\n✅ Trade ${this.config.dryRun ? 'SIMULATED' : 'EXECUTED'} successfully!`);
        if (result.orderId) {
          console.log(`  Order ID: ${result.orderId}`);
        }

        // Update position in state manager
        if (result.details) {
          const sizeDelta = order.trade.side === 'BUY'
            ? result.details.size
            : -result.details.size;

          this.stateManager.updatePosition(
            order.trade.asset,
            sizeDelta,
            result.details.price,
            {
              title: order.trade.title,
              outcome: order.trade.outcome,
            }
          );

          // Also update position manager if available
          if (this.positionManager) {
            this.positionManager.updatePositionLocal(
              order.trade.asset,
              sizeDelta,
              result.details.price,
              {
                title: order.trade.title,
                outcome: order.trade.outcome,
              }
            );
          }
        }

        // Record successful trade in stats
        this.stateManager.recordTrade(true, order.amount);
        this.stateManager.updateOrder(order.id, {
          status: 'completed',
          processedAt: Date.now(),
          result,
        });

        this.orderQueue.completeOrder(order.id, result);
      } else {
        console.log(`\n❌ Trade failed: ${result.error}`);
        this.stateManager.recordTrade(false, 0);
        this.stateManager.updateOrder(order.id, {
          status: 'failed',
          processedAt: Date.now(),
        });
        this.orderQueue.failOrder(order.id, result.error || 'Unknown error');
      }
    } catch (err: any) {
      console.log(`\n❌ Trade error: ${err?.message || err}`);
      this.stateManager.recordTrade(false, 0);
      this.stateManager.updateOrder(order.id, {
        status: 'failed',
        processedAt: Date.now(),
      });
      this.orderQueue.failOrder(order.id, err?.message || 'Unknown error');
    }
  }

  private printStatus(): void {
    console.log('\n✅ Bot is running!');
    console.log(`Tracking: ${this.config.wallets.filter(w => w.enabled).map(w => w.alias).join(', ')}`);
    console.log(`Your account: $${this.config.userAccountSize} | Max per trade: $${this.config.maxPositionSize}`);
    console.log(`Probability filter: ${this.config.minProbability * 100}% - ${this.config.maxProbability * 100}%`);

    if (this.config.enableTrading) {
      console.log(`Trading: ${this.config.dryRun ? '🔶 DRY RUN (simulated)' : '🟢 LIVE'}`);
    } else {
      console.log(`Trading: ⚪ DISABLED (monitor only)`);
    }

    console.log(`Polling: every ${this.config.pollingIntervalMs / 1000}s`);

    if (this.positionManager) {
      const positions = this.positionManager.getPositions();
      console.log(`Current positions: ${positions.length}`);
    }
  }

  async stop(): Promise<void> {
    console.log('\nShutting down...');
    this.isRunning = false;

    this.orderQueue.stop();

    if (this.monitor) {
      this.monitor.stop();
    }

    if (this.positionManager) {
      this.positionManager.stop();
    }

    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
    }

    // Save state before exit
    this.stateManager.stopAutoSave();

    console.log('Bot stopped.');
  }

  // Get current status
  getStatus(): {
    isRunning: boolean;
    positions: any[];
    orderQueue: any;
  } {
    return {
      isRunning: this.isRunning,
      positions: this.positionManager?.getPositions() || [],
      orderQueue: this.orderQueue.getStatus(),
    };
  }
}

// Main entry point
async function main() {
  const bot = new CopyTradingBot();

  // Graceful shutdown
  const shutdown = async () => {
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

main().catch(console.error);
