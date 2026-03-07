import 'dotenv/config';
import { TradeMonitor } from './services/tradeMonitor.js';
import { PositionSizer } from './services/positionSizer.js';
import { PositionManager } from './services/positionManager.js';
import { OrderQueue, QueuedOrder } from './services/orderQueue.js';
import { StateManager } from './services/stateManager.js';
import { PositionReconciler } from './services/positionReconciler.js';
import { RiskManager } from './services/riskManager.js';
import { TrailingStopMonitor } from './services/trailingStopMonitor.js';
import { TimeBasedExitMonitor } from './services/timeBasedExitMonitor.js';
import { Trader } from './services/trader.js';
import { TelegramNotifier } from './services/notifier.js';
import { HealthCheckServer } from './services/healthCheck.js';
import { DashboardServer } from './services/dashboard.js';
import { isMarketBlacklisted, isMarketWhitelisted } from './services/tradeFilter.js';
import { getConfigLoader } from './services/configLoader.js';
import { ClobApiClient } from './api/clobApi.js';
import { loadConfig, updateConfig, getConfig } from './config.js';
import { TradeSignal, WalletConfig, Trade, RecentSignal, CopyConfig } from './types/index.js';

// Conflict resolution timeout (5 minutes in milliseconds)
const CONFLICT_WINDOW_MS = 5 * 60 * 1000;

export class CopyTradingBot {
  private config = loadConfig();
  private monitor: TradeMonitor | null = null;
  private positionSizer: PositionSizer;
  private positionManager: PositionManager | null = null;
  private orderQueue: OrderQueue;
  private stateManager: StateManager;
  private reconciler: PositionReconciler | null = null;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private riskManager: RiskManager | null = null;
  private trailingStopMonitor: TrailingStopMonitor | null = null;
  private timeBasedExitMonitor: TimeBasedExitMonitor | null = null;
  private trader: Trader | null = null;
  private clobApi: ClobApiClient;
  private notifier: TelegramNotifier;
  private healthCheckServer: HealthCheckServer | null = null;
  private dashboardServer: DashboardServer | null = null;
  private isRunning = false;
  private isPaused = false;
  // Recent signals for conflict detection (in-memory, not persisted)
  private recentSignals: RecentSignal[] = [];

  constructor() {
    this.clobApi = new ClobApiClient();

    // Initialize state manager (loads persisted state)
    this.stateManager = new StateManager();

    // Initialize Telegram notifier with state manager for commands
    this.notifier = new TelegramNotifier(this.stateManager);

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

      // Show daily P&L status
      const dailyPnL = this.stateManager.getDailyPnL();
      const dailyPnLDate = this.stateManager.getDailyPnLDate();
      console.log(`  Daily P&L (${dailyPnLDate}): $${dailyPnL.toFixed(2)}`);
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

      // Initialize risk manager
      this.riskManager = new RiskManager(
        {
          stopLossPercent: -25,    // Sell if position drops 25%
          takeProfitPercent: 100,  // Sell if position doubles
          maxTradeAgeSeconds: 60,  // Skip trades older than 1 minute
          maxSpreadPercent: 0.10,  // Skip if spread > 10%
        },
        this.stateManager,
        this.trader,
        this.config.dryRun,
        this.notifier
      );
      this.riskManager.startMonitoring();

      // Initialize trailing stop monitor (if enabled via config)
      if (this.config.trailingStopPercent > 0) {
        this.trailingStopMonitor = new TrailingStopMonitor(
          {
            trailingStopPercent: this.config.trailingStopPercent,
            checkIntervalMs: this.config.trailingStopCheckIntervalMs,
          },
          this.stateManager,
          this.trader,
          this.config.dryRun,
          this.notifier
        );
        this.trailingStopMonitor.startMonitoring();
      }

      // Initialize time-based exit monitor (if enabled via config)
      if (this.config.maxHoldTimeHours > 0) {
        this.timeBasedExitMonitor = new TimeBasedExitMonitor(
          {
            maxHoldTimeHours: this.config.maxHoldTimeHours,
            checkIntervalMs: 5 * 60 * 1000, // Check every 5 minutes
          },
          this.stateManager,
          this.trader,
          this.config.dryRun,
          this.notifier
        );
        this.timeBasedExitMonitor.startMonitoring();
      }
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

    // Send Telegram notification that bot started
    await this.notifier.notifyBotStarted({
      wallets: this.config.wallets.filter(w => w.enabled).map(w => w.alias),
      accountSize: this.config.userAccountSize,
      maxPositionSize: this.config.maxPositionSize,
      dryRun: this.config.dryRun,
      tradingEnabled: this.config.enableTrading,
      positionCount: this.positionManager?.getPositions().length || 0,
    });

    // Start health check server if enabled
    if (this.config.healthCheckEnabled) {
      this.healthCheckServer = new HealthCheckServer({
        port: this.config.healthCheckPort,
        stateManager: this.stateManager,
        orderQueue: this.orderQueue,
      });

      try {
        await this.healthCheckServer.start();
      } catch (err) {
        console.error('[HealthCheck] Failed to start server:', err);
        // Continue anyway - health check is optional
      }
    }

    // Start dashboard server if enabled
    if (this.config.dashboardEnabled) {
      this.dashboardServer = new DashboardServer(
        {
          port: this.config.dashboardPort,
          stateManager: this.stateManager,
          orderQueue: this.orderQueue,
          clobApi: this.clobApi,
          trader: this.trader,
          dryRun: this.config.dryRun,
        },
        {
          onPause: () => {
            this.isPaused = true;
            console.log('[Bot] Paused via dashboard');
          },
          onResume: () => {
            this.isPaused = false;
            console.log('[Bot] Resumed via dashboard');
          },
          onForceSell: async (asset: string) => {
            return this.forceSellPosition(asset);
          },
        }
      );

      try {
        await this.dashboardServer.start();
      } catch (err) {
        console.error('[Dashboard] Failed to start server:', err);
        // Continue anyway - dashboard is optional
      }
    }

    // Start config file watcher for hot-reload
    this.setupConfigHotReload();

    console.log('\nWaiting for new trades... (Ctrl+C to stop)\n');
  }

  /**
   * Setup config file watcher for hot-reload support
   */
  private setupConfigHotReload(): void {
    const configLoader = getConfigLoader();

    // Start watching for config file changes
    configLoader.startWatching();

    // Handle config reload events
    configLoader.on('configReload', (newConfig: Partial<CopyConfig>) => {
      console.log('\n[Config] Hot-reloading configuration...');

      // Update the global config with hot-reloadable settings
      updateConfig(newConfig);

      // Re-read the updated config
      this.config = getConfig();

      // Update position sizer with new limits
      this.positionSizer = new PositionSizer({
        userAccountSize: this.config.userAccountSize,
        maxPositionSize: this.config.maxPositionSize,
        minTradeSize: this.config.minTradeSize,
        maxPercentage: this.config.maxPercentagePerTrade,
      });

      // Update trailing stop monitor if percent changed
      if (this.trailingStopMonitor && this.config.trailingStopPercent > 0) {
        this.trailingStopMonitor.updateConfig({
          trailingStopPercent: this.config.trailingStopPercent,
          checkIntervalMs: this.config.trailingStopCheckIntervalMs,
        });
      }

      // Update time-based exit monitor if hours changed
      if (this.timeBasedExitMonitor && this.config.maxHoldTimeHours > 0) {
        this.timeBasedExitMonitor.updateConfig({
          maxHoldTimeHours: this.config.maxHoldTimeHours,
        });
      }

      // Update trader dry run mode
      if (this.trader) {
        this.trader.setDryRun(this.config.dryRun);
      }

      console.log('[Config] Configuration hot-reloaded successfully');
    });
  }

  /**
   * Clean up signals older than the conflict window (5 minutes)
   */
  private cleanupOldSignals(): void {
    const cutoffTime = Date.now() - CONFLICT_WINDOW_MS;
    this.recentSignals = this.recentSignals.filter(s => s.timestamp >= cutoffTime);
  }

  /**
   * Add a new signal to the recent signals list
   */
  private recordSignal(trade: Trade, wallet: WalletConfig): void {
    this.cleanupOldSignals();

    this.recentSignals.push({
      market: trade.conditionId,
      side: trade.side,
      outcome: trade.outcome,
      walletAlias: wallet.alias,
      walletAddress: wallet.address,
      allocation: wallet.allocation ?? 100,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if a trade conflicts with recent signals from other traders
   * Returns conflicting signals if any exist
   */
  private findConflictingSignals(trade: Trade, currentWallet: WalletConfig): RecentSignal[] {
    this.cleanupOldSignals();

    return this.recentSignals.filter(signal => {
      // Must be same market
      if (signal.market !== trade.conditionId) return false;

      // Must be from a different wallet
      if (signal.walletAddress.toLowerCase() === currentWallet.address.toLowerCase()) return false;

      // Check for opposite trades:
      // 1. BUY vs SELL on same outcome
      // 2. BUY Yes vs BUY No (or SELL Yes vs SELL No) on same market
      const isSameOutcome = signal.outcome === trade.outcome;
      const isOppositeSide = signal.side !== trade.side;
      const isOppositeOutcome = signal.outcome !== trade.outcome && signal.side === trade.side;

      return (isSameOutcome && isOppositeSide) || isOppositeOutcome;
    });
  }

  /**
   * Resolve trade conflict using the configured strategy
   * Returns: { shouldExecute: boolean, reason: string }
   */
  private resolveConflict(
    trade: Trade,
    currentWallet: WalletConfig,
    conflictingSignals: RecentSignal[]
  ): { shouldExecute: boolean; reason: string } {
    const strategy = this.config.conflictStrategy;

    // Create current signal for comparison
    const currentSignal: RecentSignal = {
      market: trade.conditionId,
      side: trade.side,
      outcome: trade.outcome,
      walletAlias: currentWallet.alias,
      walletAddress: currentWallet.address,
      allocation: currentWallet.allocation ?? 100,
      timestamp: Date.now(),
    };

    switch (strategy) {
      case 'first':
        // Follow the first signal received (current behavior)
        // Since we're processing the current trade, the conflicting signals were first
        return {
          shouldExecute: false,
          reason: `strategy 'first' - following earlier signal from ${conflictingSignals[0].walletAlias}`,
        };

      case 'skip':
        // Skip all conflicting trades
        return {
          shouldExecute: false,
          reason: `strategy 'skip' - conflict detected with ${conflictingSignals.map(s => s.walletAlias).join(', ')}`,
        };

      case 'majority': {
        // Count votes for each side
        // Group signals by their "vote" (combination of side + outcome)
        const allSignals = [...conflictingSignals, currentSignal];
        const votes: Record<string, string[]> = {};

        for (const signal of allSignals) {
          // Normalize the vote: BUY Yes = SELL No, BUY No = SELL Yes
          // Convert to a canonical form: "bullish" (betting Yes wins) or "bearish" (betting No wins)
          const isBullish = (signal.side === 'BUY' && signal.outcome === 'Yes') ||
                          (signal.side === 'SELL' && signal.outcome === 'No');
          const voteKey = isBullish ? 'bullish' : 'bearish';

          if (!votes[voteKey]) votes[voteKey] = [];
          votes[voteKey].push(signal.walletAlias);
        }

        const bullishCount = votes['bullish']?.length || 0;
        const bearishCount = votes['bearish']?.length || 0;

        // Determine if current signal aligns with majority
        const currentIsBullish = (trade.side === 'BUY' && trade.outcome === 'Yes') ||
                                (trade.side === 'SELL' && trade.outcome === 'No');
        const currentVote = currentIsBullish ? 'bullish' : 'bearish';

        if (bullishCount === bearishCount) {
          return {
            shouldExecute: false,
            reason: `strategy 'majority' - tie vote (${bullishCount} bullish vs ${bearishCount} bearish), skipping`,
          };
        }

        const majorityVote = bullishCount > bearishCount ? 'bullish' : 'bearish';
        const majorityTraders = votes[majorityVote]?.join(', ') || '';

        if (currentVote === majorityVote) {
          return {
            shouldExecute: true,
            reason: `strategy 'majority' - current trade aligns with majority (${majorityTraders})`,
          };
        } else {
          return {
            shouldExecute: false,
            reason: `strategy 'majority' - majority opposes (${majorityTraders})`,
          };
        }
      }

      case 'highest_allocation': {
        // Follow the trader with highest allocation
        const allSignals = [...conflictingSignals, currentSignal];

        // Group by vote direction
        const bullishSignals = allSignals.filter(s =>
          (s.side === 'BUY' && s.outcome === 'Yes') || (s.side === 'SELL' && s.outcome === 'No')
        );
        const bearishSignals = allSignals.filter(s =>
          (s.side === 'BUY' && s.outcome === 'No') || (s.side === 'SELL' && s.outcome === 'Yes')
        );

        // Find max allocation in each direction
        const maxBullish = bullishSignals.length > 0
          ? Math.max(...bullishSignals.map(s => s.allocation))
          : 0;
        const maxBearish = bearishSignals.length > 0
          ? Math.max(...bearishSignals.map(s => s.allocation))
          : 0;

        // Check for tie
        if (maxBullish === maxBearish) {
          return {
            shouldExecute: false,
            reason: `strategy 'highest_allocation' - tie at ${maxBullish}% allocation, skipping`,
          };
        }

        // Find which direction wins and who has the highest allocation
        const winningDirection = maxBullish > maxBearish ? 'bullish' : 'bearish';
        const winningSignals = winningDirection === 'bullish' ? bullishSignals : bearishSignals;
        const winner = winningSignals.find(s => s.allocation === (winningDirection === 'bullish' ? maxBullish : maxBearish));

        // Check if current signal is in the winning direction
        const currentIsBullish = (trade.side === 'BUY' && trade.outcome === 'Yes') ||
                                (trade.side === 'SELL' && trade.outcome === 'No');
        const currentDirection = currentIsBullish ? 'bullish' : 'bearish';

        if (currentDirection === winningDirection) {
          return {
            shouldExecute: true,
            reason: `strategy 'highest_allocation' - following ${winner?.walletAlias} (${winner?.allocation}% allocation)`,
          };
        } else {
          return {
            shouldExecute: false,
            reason: `strategy 'highest_allocation' - ${winner?.walletAlias} (${winner?.allocation}%) opposes`,
          };
        }
      }

      default:
        return { shouldExecute: true, reason: 'unknown strategy, allowing trade' };
    }
  }

  private async handleTradeSignal(signal: TradeSignal, wallet: WalletConfig): Promise<void> {
    // Check if bot is paused
    if (this.isPaused) {
      console.log(`[Paused] Ignoring trade signal from ${wallet.alias} - bot is paused`);
      return;
    }

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

    // Filter by market blacklist
    if (isMarketBlacklisted(trade.title, this.config.blacklistKeywords)) {
      console.log(`[Blacklist] Skipped ${wallet.alias}'s trade on "${trade.title}" (market blacklisted)`);
      return;
    }

    // Filter by market whitelist (if whitelist is configured, trade must match)
    if (!isMarketWhitelisted(trade.title, this.config.whitelistKeywords)) {
      console.log(`[Filter] Trade skipped - not in whitelist: ${trade.title}`);
      return;
    }

    // Buy-only mode: skip sell signals from tracked traders (internal exits like stop-loss still work)
    if (trade.side === 'SELL' && !this.config.copySells) {
      console.log(`[BuyOnly] Ignored ${wallet.alias}'s SELL signal on "${trade.title}" - buy-only mode enabled`);
      return;
    }

    // Risk checks (stale trade, wide spread)
    if (this.riskManager) {
      const riskCheck = await this.riskManager.checkTradeSignal(trade.timestamp, trade.asset);
      if (!riskCheck.passed) {
        console.log(`[Risk] Skipped ${wallet.alias}'s trade: ${riskCheck.reason}`);
        return;
      }
    }

    // Check daily loss limit for BUY signals only (allow sells to close positions)
    if (trade.side === 'BUY' && this.config.dailyLossLimit > 0) {
      if (this.stateManager.isDailyLossLimitExceeded(this.config.dailyLossLimit)) {
        const dailyPnL = this.stateManager.getDailyPnL();
        console.log(`[DailyLimit] Skipped ${wallet.alias}'s BUY on "${trade.title}" - daily loss limit exceeded (P&L: $${dailyPnL.toFixed(2)}, limit: -$${this.config.dailyLossLimit})`);
        return;
      }
    }

    // Check max open positions limit for BUY signals only
    if (trade.side === 'BUY' && this.config.maxOpenPositions > 0) {
      const currentPositions = this.stateManager.getOpenPositionsCount();
      // Only count as new position if we don't already have this asset
      const isNewPosition = !this.stateManager.hasPosition(trade.asset);
      if (isNewPosition && currentPositions >= this.config.maxOpenPositions) {
        console.log(`[Limit] Skipped ${wallet.alias}'s BUY on "${trade.title}" - at max positions (${currentPositions}/${this.config.maxOpenPositions})`);
        return;
      }
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

    // Conflict detection (only if tracking more than 1 wallet and strategy is not 'first')
    const enabledWallets = this.config.wallets.filter(w => w.enabled);
    if (enabledWallets.length > 1 && this.config.conflictStrategy !== 'first') {
      const conflictingSignals = this.findConflictingSignals(trade, wallet);

      if (conflictingSignals.length > 0) {
        console.log(`\n⚠️  [Conflict] ${wallet.alias}'s ${trade.side} ${trade.outcome} on "${trade.title}"`);
        console.log(`    Conflicts with: ${conflictingSignals.map(s => `${s.walletAlias} (${s.side} ${s.outcome})`).join(', ')}`);

        const resolution = this.resolveConflict(trade, wallet, conflictingSignals);
        console.log(`    Resolution: ${resolution.reason}`);

        if (!resolution.shouldExecute) {
          // Still record the signal for future conflict detection
          this.recordSignal(trade, wallet);
          return;
        }
      }
    }

    // Record this signal for future conflict detection
    this.recordSignal(trade, wallet);

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

      if (sizing.cappedSize === 0) {
        console.log(`\n⏭️  Skipping trade (${sizing.reason})`);
        console.log('='.repeat(50) + '\n');
        return;
      }

      // Apply per-trader allocation
      const allocation = wallet.allocation ?? 100; // Default to 100% if not specified
      const allocatedSize = sizing.cappedSize * (allocation / 100);
      console.log(`  Allocation: ${allocation}% -> $${allocatedSize.toFixed(2)}`);

      // Check if allocated size is below minimum trade size
      if (allocatedSize < this.config.minTradeSize) {
        console.log(`\n⏭️  Skipping trade (allocated size $${allocatedSize.toFixed(2)} below minimum $${this.config.minTradeSize})`);
        console.log('='.repeat(50) + '\n');
        return;
      }

      finalSize = allocatedSize;
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

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async executeOrder(order: QueuedOrder): Promise<void> {
    if (!this.trader) {
      this.orderQueue.failOrder(order.id, 'Trader not initialized');
      return;
    }

    const retryCount = order.retryCount || 0;
    const isRetry = retryCount > 0;

    console.log(`\n🔄 Executing order: ${order.id}${isRetry ? ` (retry ${retryCount}/${this.config.maxRetries})` : ''}`);
    console.log(`  ${order.trade.side} $${order.amount.toFixed(2)} on ${order.trade.outcome}`);

    // Record order in state (only on first attempt)
    if (!isRetry) {
      this.stateManager.addOrder({
        id: order.id,
        asset: order.trade.asset,
        side: order.trade.side as 'BUY' | 'SELL',
        amount: order.amount,
        status: 'processing',
        createdAt: order.createdAt,
        walletAlias: order.walletAlias,
      });
    }

    // Add delay if configured (only on first attempt)
    if (!isRetry && this.config.copyDelayMs > 0) {
      await this.delay(this.config.copyDelayMs);
    }

    try {
      const result = await this.trader.copyTrade(order.trade, order.amount);

      if (result.success) {
        console.log(`\n✅ Trade ${this.config.dryRun ? 'SIMULATED' : 'EXECUTED'} successfully!${isRetry ? ` (after ${retryCount} retries)` : ''}`);
        if (result.orderId) {
          console.log(`  Order ID: ${result.orderId}`);
        }

        // For SELL orders, capture position info before updating (for trader stats and daily P&L)
        let positionBeforeSell: { avgPrice: number; entryTime: number; walletAlias?: string } | null = null;
        if (order.trade.side === 'SELL') {
          const existingPosition = this.stateManager.getPosition(order.trade.asset);
          if (existingPosition) {
            positionBeforeSell = {
              avgPrice: existingPosition.avgPrice,
              entryTime: existingPosition.entryTime,
              walletAlias: existingPosition.walletAlias,
            };
          }
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

          // For BUY orders on new positions, set the wallet alias
          if (order.trade.side === 'BUY') {
            this.stateManager.setPositionWalletAlias(order.trade.asset, order.walletAlias);
          }

          // For SELL orders, record trader stats
          if (order.trade.side === 'SELL' && positionBeforeSell) {
            const sellPrice = result.details.price;
            const sharesSold = result.details.size;
            const pnl = (sellPrice - positionBeforeSell.avgPrice) * sharesSold;
            const holdTimeMs = Date.now() - positionBeforeSell.entryTime;

            // Use the wallet alias from the position (who opened it) or the current order's alias as fallback
            const traderAlias = positionBeforeSell.walletAlias || order.walletAlias;
            this.stateManager.recordTraderTrade(traderAlias, pnl, holdTimeMs);
          }

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

        // Update daily P&L
        // For BUY: We spend money (negative P&L equal to the amount spent)
        // For SELL: We realize P&L based on sell price vs avg cost
        if (result.details) {
          let pnlChange = 0;
          if (order.trade.side === 'BUY') {
            // When buying, the immediate P&L impact is the cost (negative)
            // We treat it as neutral (0) since we're acquiring an asset
            // The actual P&L will be realized on SELL
            pnlChange = 0;
          } else {
            // When selling, calculate realized P&L
            // P&L = (sell price - avg entry price) * shares sold
            // Note: Position may already be deleted by updatePosition if fully closed
            // so we use positionBeforeSell which was captured earlier
            const avgPrice = positionBeforeSell?.avgPrice || parseFloat(String(order.trade.price));
            const sellPrice = result.details.price;
            const sharesSold = result.details.size;
            pnlChange = (sellPrice - avgPrice) * sharesSold;
          }
          this.stateManager.updateDailyPnL(pnlChange);
        }

        this.orderQueue.completeOrder(order.id, result);

        // Update health check last trade time
        if (this.healthCheckServer) {
          this.healthCheckServer.updateLastTradeTime();
        }

        // Send Telegram notification for successful trade
        await this.notifier.notifyTradeExecuted({
          side: order.trade.side as 'BUY' | 'SELL',
          title: order.trade.title,
          outcome: order.trade.outcome,
          amount: order.amount,
          price: result.details?.price || parseFloat(String(order.trade.price)),
          size: result.details?.size,
          orderId: result.orderId,
          walletAlias: order.walletAlias,
        });
      } else {
        // Trade failed - check if we should retry
        await this.handleOrderFailure(order, result.error || 'Unknown error');
      }
    } catch (err: any) {
      // Exception occurred - check if we should retry
      await this.handleOrderFailure(order, err?.message || 'Unknown error');
    }
  }

  /**
   * Handle order failure with retry logic using exponential backoff
   */
  private async handleOrderFailure(order: QueuedOrder, errorMessage: string): Promise<void> {
    const currentRetryCount = order.retryCount || 0;

    if (currentRetryCount < this.config.maxRetries) {
      // Calculate exponential backoff delay: baseDelay * attemptNumber
      const retryDelay = this.config.retryDelayMs * (currentRetryCount + 1);

      console.log(`\n⚠️ Trade failed: ${errorMessage}`);
      console.log(`  Retrying in ${retryDelay / 1000}s... (attempt ${currentRetryCount + 1}/${this.config.maxRetries})`);

      // Update retry count on the order
      order.retryCount = currentRetryCount + 1;

      // Wait for exponential backoff delay
      await this.delay(retryDelay);

      // Retry the order
      await this.executeOrder(order);
    } else {
      // Max retries exceeded - mark as permanently failed
      console.log(`\n❌ Trade failed after ${currentRetryCount} retries: ${errorMessage}`);
      this.stateManager.recordTrade(false, 0);
      this.stateManager.updateOrder(order.id, {
        status: 'failed',
        processedAt: Date.now(),
      });
      this.orderQueue.failOrder(order.id, `${errorMessage} (after ${currentRetryCount} retries)`);

      // Send Telegram notification for failed trade (only after all retries exhausted)
      await this.notifier.notifyTradeFailed({
        side: order.trade.side as 'BUY' | 'SELL',
        title: order.trade.title,
        outcome: order.trade.outcome,
        amount: order.amount,
        error: `${errorMessage} (after ${currentRetryCount} retries)`,
        walletAlias: order.walletAlias,
      });
    }
  }

  /**
   * Force sell a position (called from dashboard)
   */
  private async forceSellPosition(asset: string): Promise<{ success: boolean; error?: string }> {
    const position = this.stateManager.getPosition(asset);
    if (!position) {
      return { success: false, error: 'Position not found' };
    }

    if (!this.trader) {
      return { success: false, error: 'Trader not initialized' };
    }

    console.log(`\n[Dashboard] Force selling position: ${position.title}`);

    try {
      // Get current price for the sell
      const currentPrice = await this.clobApi.getMidpoint(asset);
      const price = parseFloat(currentPrice);

      // Create a synthetic trade for the sell
      const trade = {
        id: `dashboard-sell-${Date.now()}`,
        proxyWallet: '',
        side: 'SELL' as const,
        asset,
        conditionId: '',
        size: String(position.size),
        price: String(price),
        timestamp: Math.floor(Date.now() / 1000),
        title: position.title,
        slug: position.slug,
        outcome: position.outcome,
        outcomeIndex: 0,
        transactionHash: '',
        eventSlug: '',
      };

      // Calculate sell amount
      const amount = position.size * price;

      // Execute the sell
      const result = await this.trader.copyTrade(trade, amount);

      if (result.success) {
        // Capture position info before updating for P&L calculation
        const avgPrice = position.avgPrice;
        const entryTime = position.entryTime;
        const walletAlias = position.walletAlias || 'Dashboard';

        // Update state manager
        if (result.details) {
          this.stateManager.updatePosition(
            asset,
            -result.details.size,
            result.details.price,
            { title: position.title, outcome: position.outcome }
          );

          // Record trader stats
          const sellPrice = result.details.price;
          const sharesSold = result.details.size;
          const pnl = (sellPrice - avgPrice) * sharesSold;
          const holdTimeMs = Date.now() - entryTime;
          this.stateManager.recordTraderTrade(walletAlias, pnl, holdTimeMs);

          // Update daily P&L
          this.stateManager.updateDailyPnL(pnl);
        }

        // Record successful trade
        this.stateManager.recordTrade(true, amount);

        // Update dashboard last trade time
        if (this.dashboardServer) {
          this.dashboardServer.updateLastTradeTime();
        }

        // Send notification
        await this.notifier.notifyTradeExecuted({
          side: 'SELL',
          title: position.title,
          outcome: position.outcome,
          amount,
          price: result.details?.price || price,
          size: result.details?.size || position.size,
          orderId: result.orderId,
          walletAlias: 'Dashboard',
        });

        console.log(`[Dashboard] Position sold successfully`);
        return { success: true };
      } else {
        return { success: false, error: result.error || 'Trade failed' };
      }
    } catch (err: any) {
      console.error('[Dashboard] Force sell failed:', err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  private printStatus(): void {
    console.log('\n✅ Bot is running!');
    const enabledWallets = this.config.wallets.filter(w => w.enabled);
    const walletInfo = enabledWallets.map(w => `${w.alias} (${w.allocation ?? 100}%)`).join(', ');
    console.log(`Tracking: ${walletInfo}`);
    console.log(`Your account: $${this.config.userAccountSize} | Max per trade: $${this.config.maxPositionSize}`);
    console.log(`Probability filter: ${this.config.minProbability * 100}% - ${this.config.maxProbability * 100}%`);

    if (this.config.blacklistKeywords.length > 0) {
      console.log(`Blacklist: ${this.config.blacklistKeywords.join(', ')}`);
    }

    if (this.config.whitelistKeywords.length > 0) {
      console.log(`Whitelist: ${this.config.whitelistKeywords.join(', ')}`);
    }

    if (this.config.enableTrading) {
      console.log(`Trading: ${this.config.dryRun ? '🔶 DRY RUN (simulated)' : '🟢 LIVE'}`);
    } else {
      console.log(`Trading: ⚪ DISABLED (monitor only)`);
    }

    // Show copy mode (buy-only vs full)
    if (this.config.copySells) {
      console.log(`Copy Mode: Full (copying buys and sells)`);
    } else {
      console.log(`Copy Mode: Buy-Only (ignoring sell signals)`);
    }

    console.log(`Polling: every ${this.config.pollingIntervalMs / 1000}s`);
    console.log(`Retry: max ${this.config.maxRetries} attempts, ${this.config.retryDelayMs}ms base delay`);

    // Show position count with limit if configured
    const currentPositions = this.stateManager.getOpenPositionsCount();
    if (this.config.maxOpenPositions > 0) {
      console.log(`Positions: ${currentPositions}/${this.config.maxOpenPositions}`);
    } else {
      console.log(`Positions: ${currentPositions} (no limit)`);
    }

    // Show daily P&L and loss limit status
    const dailyPnL = this.stateManager.getDailyPnL();
    const dailyPnLDate = this.stateManager.getDailyPnLDate();
    if (this.config.dailyLossLimit > 0) {
      const isLimitExceeded = this.stateManager.isDailyLossLimitExceeded(this.config.dailyLossLimit);
      const status = isLimitExceeded ? 'LIMIT EXCEEDED - new trades blocked' : 'OK';
      console.log(`Daily P&L (${dailyPnLDate}): $${dailyPnL.toFixed(2)} / -$${this.config.dailyLossLimit} (${status})`);
    } else {
      console.log(`Daily P&L (${dailyPnLDate}): $${dailyPnL.toFixed(2)} (no limit)`);
    }

    // Show conflict resolution strategy (only relevant when tracking multiple wallets)
    if (enabledWallets.length > 1) {
      console.log(`Conflict Strategy: ${this.config.conflictStrategy}`);
    }

    // Show trailing stop status
    if (this.config.trailingStopPercent > 0) {
      console.log(`Trailing Stop: ${this.config.trailingStopPercent}% from peak (check every ${this.config.trailingStopCheckIntervalMs / 1000}s)`);
    } else {
      console.log(`Trailing Stop: disabled`);
    }

    // Show max hold time status
    if (this.config.maxHoldTimeHours > 0) {
      console.log(`Max Hold Time: ${this.config.maxHoldTimeHours}h`);
    } else {
      console.log(`Max Hold Time: none`);
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

    if (this.riskManager) {
      this.riskManager.stopMonitoring();
    }

    if (this.trailingStopMonitor) {
      this.trailingStopMonitor.stopMonitoring();
    }

    if (this.timeBasedExitMonitor) {
      this.timeBasedExitMonitor.stopMonitoring();
    }

    // Stop health check server
    if (this.healthCheckServer) {
      await this.healthCheckServer.stop();
    }

    // Stop dashboard server
    if (this.dashboardServer) {
      await this.dashboardServer.stop();
    }

    // Stop config file watcher
    const configLoader = getConfigLoader();
    configLoader.stopWatching();

    // Send Telegram notification that bot stopped
    const stats = this.stateManager.getStats();
    await this.notifier.notifyBotStopped(stats);

    // Stop Telegram polling
    await this.notifier.stopPolling();

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
