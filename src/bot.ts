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
import { PositionWatchdog } from './services/positionWatchdog.js';
import { Trader } from './services/trader.js';
import { TelegramNotifier } from './services/notifier.js';
import { HealthCheckServer } from './services/healthCheck.js';
import { DashboardServer } from './services/dashboard.js';
import { isMarketBlacklisted, isMarketWhitelisted } from './services/tradeFilter.js';
import { getConfigLoader } from './services/configLoader.js';
import { ClobApiClient } from './api/clobApi.js';
import { loadConfig, updateConfig, getConfig } from './config.js';
import { errorLogger } from './services/errorLogger.js';
import { TradeSignal, WalletConfig, Trade, RecentSignal, CopyConfig } from './types/index.js';

// Conflict resolution timeout (5 minutes in milliseconds)
const CONFLICT_WINDOW_MS = 5 * 60 * 1000;
// Dedup window: ignore duplicate BUY signals for same asset within this period
const DEDUP_WINDOW_MS = 30 * 1000;

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
  private watchdog: PositionWatchdog | null = null;
  private trader: Trader | null = null;
  private clobApi: ClobApiClient;
  private notifier: TelegramNotifier;
  private healthCheckServer: HealthCheckServer | null = null;
  private dashboardServer: DashboardServer | null = null;
  private isRunning = false;
  private isPaused = false;
  // Recent signals for conflict detection (in-memory, not persisted)
  private recentSignals: RecentSignal[] = [];
  // Dedup map: asset -> last processed timestamp (prevents burst duplicates)
  private recentBuyDedup: Map<string, number> = new Map();

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
      fixedTradePercent: (this.config as any).fixedTradePercent,
    });

    this.orderQueue = new OrderQueue({
      maxConcurrent: 3, // Allow parallel orders for different assets
      orderDelayMs: 200, // Reduced delay between orders for speed
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
      } catch (err: any) {
        errorLogger.logError('Bot.initTrader', err);
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

      // Start periodic reconciliation (every 10 minutes)
      this.reconcileInterval = setInterval(async () => {
        if (this.stateManager.getAllPositions().length > 0) {
          try {
            await this.reconciler!.reconcile();
          } catch (err) {
            console.error('Periodic reconciliation failed:', err);
          }
        }
      }, 10 * 60 * 1000); // Every 10 minutes
      console.log('[Reconciler] Periodic check enabled (every 10m)');

      // Initialize risk manager
      this.riskManager = new RiskManager(
        {
          stopLossPercent: this.config.stopLossPercent,
          takeProfitPercent: this.config.takeProfitPercent,
          maxTradeAgeSeconds: 60,  // Skip trades older than 1 minute
          maxPriceDiffPercent: parseFloat(process.env.MAX_PRICE_DIFF_PERCENT || '5'),  // Skip if price moved >5% from trader
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

      // Initialize position watchdog (runs every 60s, validates all positions)
      this.watchdog = new PositionWatchdog(
        {
          checkIntervalMs: 10_000, // Every 10 seconds
          stopLossPercent: this.config.stopLossPercent,
          takeProfitPercent: this.config.takeProfitPercent,
        },
        this.stateManager,
        this.trader,
        this.notifier
      );
      this.watchdog.start();
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

    // Pre-fetch trader profiles to avoid 429 burst on first trade signals
    console.log('\nPre-fetching trader profiles...');
    for (const wallet of this.config.wallets.filter(w => w.enabled)) {
      try {
        await this.positionSizer.getTraderProfile(wallet.address);
        console.log(`  [Sizer] Cached profile for ${wallet.alias}`);
      } catch (err: any) {
        console.warn(`  [Sizer] Failed to pre-fetch ${wallet.alias}: ${err?.message}`);
      }
    }

    // Start monitoring
    console.log('\nStarting trade monitor...');
    await this.monitor.start();

    this.isRunning = true;
    this.printStatus();

    // Place TP orders for existing positions that don't have them yet
    await this.placeProtectionOrdersForExistingPositions();

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
          onSellAll: async () => {
            return this.sellAllPositions();
          },
          onCancelAllOrders: async () => {
            return this.cancelAllOpenOrders();
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
        fixedTradePercent: (this.config as any).fixedTradePercent,
      });

      // Update risk manager SL/TP if changed
      if (this.riskManager) {
        this.riskManager.updateConfig({
          stopLossPercent: this.config.stopLossPercent,
          takeProfitPercent: this.config.takeProfitPercent,
        });
      }

      // Update watchdog SL/TP if changed
      if (this.watchdog) {
        this.watchdog.updateConfig({
          stopLossPercent: this.config.stopLossPercent,
          takeProfitPercent: this.config.takeProfitPercent,
        });
      }

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

    // Risk checks (stale trade, price slippage)
    if (this.riskManager) {
      const riskCheck = await this.riskManager.checkTradeSignal(trade.timestamp, trade.asset, parseFloat(String(trade.price)), trade.side as 'BUY' | 'SELL');
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

    // Dedup: skip duplicate BUY signals for same asset within 30s window
    if (trade.side === 'BUY') {
      const lastProcessed = this.recentBuyDedup.get(trade.asset);
      if (lastProcessed && Date.now() - lastProcessed < DEDUP_WINDOW_MS) {
        console.log(`[Dedup] Skipped duplicate BUY on "${trade.title}" (last processed ${((Date.now() - lastProcessed) / 1000).toFixed(1)}s ago)`);
        return;
      }
    }

    // Check per-position cap: skip BUY if we already have maxPositionSize worth in this asset
    if (trade.side === 'BUY' && this.config.maxPositionSize > 0) {
      const existingPosition = this.stateManager.getPosition(trade.asset);
      if (existingPosition) {
        const currentValue = existingPosition.size * existingPosition.avgPrice;
        if (currentValue >= this.config.maxPositionSize) {
          console.log(`[PositionCap] Skipped ${wallet.alias}'s BUY on "${trade.title}" - position already $${currentValue.toFixed(2)} (max: $${this.config.maxPositionSize})`);
          return;
        }
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
      let allocatedSize = sizing.cappedSize * (allocation / 100);
      console.log(`  Allocation: ${allocation}% -> $${allocatedSize.toFixed(2)}`);

      // Check if allocated size is below minimum trade size - bump up if within limits
      if (allocatedSize < this.config.minTradeSize) {
        if (allocatedSize >= 0.5) {
          // Close enough to minimum - bump up
          allocatedSize = this.config.minTradeSize;
          console.log(`  Bumped to minimum: $${allocatedSize.toFixed(2)}`);
        } else {
          console.log(`\n⏭️  Skipping trade (allocated size $${allocatedSize.toFixed(2)} below minimum $${this.config.minTradeSize})`);
          console.log('='.repeat(50) + '\n');
          return;
        }
      }

      // Polymarket's actual minimum is ~$1 or ~1 share.
      // Let the exchange reject if truly too small — don't over-filter here.

      finalSize = allocatedSize;
    } catch (err: any) {
      console.log(`\n  [Could not calculate position size - skipping]`);
      console.log(`  Error: ${err?.message || err}`);
      console.log('='.repeat(50) + '\n');
      return;
    }

    // For SELL, adjust size to what we actually have
    if (trade.side === 'SELL') {
      const ourPosition = this.stateManager.getPosition(trade.asset);
      if (ourPosition) {
        // Sell our entire position when trader sells (safest approach)
        // We can't reliably calculate what % of their position they sold
        // since we don't know their total position size before the sell
        const ourSellSize = ourPosition.size;
        finalSize = ourSellSize * tradePrice; // Convert to USD value for the order
        console.log(`  Selling our position: ${ourSellSize.toFixed(4)} shares ($${finalSize.toFixed(2)})`);
      }
    }

    // Log market liquidity (informational only — FAK + price limit handles thin books)
    try {
      const spread = await this.clobApi.getSpread(trade.asset);
      console.log(`\n💹 Current Market: Bid: $${spread.bid} | Ask: $${spread.ask} | Spread: $${spread.spread}`);
    } catch (err) {
      console.log(`\n💹 Could not check market liquidity`);
    }

    // Queue the order
    if (this.config.enableTrading && finalSize > 0) {
      // Mark asset as recently processed to prevent burst duplicates
      if (trade.side === 'BUY') {
        this.recentBuyDedup.set(trade.asset, Date.now());
      }
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
      // Cancel SL/TP protection orders before selling (so they don't conflict)
      if (order.trade.side === 'SELL') {
        await this.cancelProtectionOrders(order.trade.asset);
        // Refresh balance allowance for conditional tokens before selling.
        // The CLOB server caches balances, so we must update it with the specific
        // token_id to ensure the sell order doesn't get rejected with "not enough balance".
        await this.trader.updateBalanceAllowance(order.trade.asset);
        await this.delay(1000); // Allow allowance to propagate
      }

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

          // For BUY orders on new positions, set the wallet alias and place SL/TP orders
          if (order.trade.side === 'BUY') {
            this.stateManager.setPositionWalletAlias(order.trade.asset, order.walletAlias);

            // Place take profit limit order on the exchange
            // (stop loss handled by polling - limit sell below market fills immediately on Polymarket)
            await this.placeProtectionOrders(
              order.trade.asset,
              result.details.price,
              result.details.size,
              order.trade.title,
            );

            // Update WebSocket subscriptions for trailing stop
            if (this.trailingStopMonitor) {
              this.trailingStopMonitor.updateSubscriptions();
            }
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
   * Handle order failure with retry logic using exponential backoff.
   * Non-retryable errors (invalid amount, min size, bad signature) skip retries entirely.
   */
  private async handleOrderFailure(order: QueuedOrder, errorMessage: string): Promise<void> {
    const currentRetryCount = order.retryCount || 0;

    // Check if this error is permanent (won't be fixed by retrying)
    const isNonRetryable = Trader.isNonRetryableError(errorMessage);

    if (!isNonRetryable && currentRetryCount < this.config.maxRetries) {
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
      // Non-retryable error or max retries exceeded - mark as permanently failed
      const failReason = isNonRetryable
        ? `${errorMessage} (non-retryable)`
        : `${errorMessage} (after ${currentRetryCount} retries)`;

      errorLogger.log('Bot.orderFailed', failReason, {
        side: order.trade.side,
        asset: order.trade.asset?.slice(0, 30),
        title: order.trade.title?.slice(0, 40),
        amount: order.amount,
      });

      if (isNonRetryable) {
        console.log(`\n❌ Trade failed (non-retryable): ${errorMessage}`);
      } else {
        console.log(`\n❌ Trade failed after ${currentRetryCount} retries: ${errorMessage}`);
      }

      this.stateManager.recordTrade(false, 0);
      this.stateManager.updateOrder(order.id, {
        status: 'failed',
        processedAt: Date.now(),
      });
      this.orderQueue.failOrder(order.id, failReason);

      // Send Telegram notification for failed trade
      await this.notifier.notifyTradeFailed({
        side: order.trade.side as 'BUY' | 'SELL',
        title: order.trade.title,
        outcome: order.trade.outcome,
        amount: order.amount,
        error: failReason,
        walletAlias: order.walletAlias,
      });
    }
  }

  /**
   * Place GTC take profit limit order on the exchange.
   * Called after a successful BUY order fills.
   *
   * NOTE: Stop loss CANNOT be a limit order on Polymarket because a SELL limit
   * at a price below market would fill immediately (it means "sell at X or better").
   * Stop loss is handled by polling (RiskManager checks every 60s).
   * Take profit CAN be a limit order because a SELL at a price above market
   * will only fill when the price rises to that level.
   */
  private async placeProtectionOrders(asset: string, entryPrice: number, shares: number, title: string): Promise<void> {
    if (!this.trader || this.config.dryRun) return;

    const tpPercent = this.config.takeProfitPercent / 100; // e.g., 150 -> 1.50
    const takeProfitPrice = Math.min(0.99, Math.round((entryPrice * (1 + tpPercent)) * 100) / 100);

    // Skip if TP price would be at or below current price (would fill immediately)
    if (takeProfitPrice <= entryPrice) {
      console.log(`  TP price ($${takeProfitPrice}) <= entry ($${entryPrice}), skipping TP order`);
      return;
    }

    // Skip if position too small for Polymarket minimum order size (5 shares)
    if (shares < 5) {
      console.log(`  TP skipped: ${shares.toFixed(2)} shares below Polymarket minimum (5)`);
      return;
    }

    console.log(`\n🛡️ Placing take profit order for ${title}:`);
    console.log(`  Entry: $${entryPrice.toFixed(2)} | Shares: ${shares.toFixed(2)}`);
    console.log(`  Take Profit: SELL @ $${takeProfitPrice.toFixed(2)} (+${(tpPercent * 100).toFixed(0)}%)`);
    console.log(`  Stop Loss: handled by polling (${this.config.stopLossPercent}%)`);

    let tpOrderId: string | undefined;

    // Update balance allowance for this specific token (required for GTC sell orders)
    // The exchange needs time to settle the BUY and register conditional tokens.
    // "delayed" orders can take 5-15 seconds to settle on-chain.
    // If this initial attempt fails, the PositionWatchdog (runs every 10s) will retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Wait longer before first attempt to give the BUY time to settle
      await this.delay(attempt === 0 ? 8000 : 5000);
      await this.trader.updateBalanceAllowance(asset);
      await this.delay(2000); // Let allowance propagate

      try {
        const tpResult = await this.trader.placeLimitOrder(asset, 'SELL', shares, takeProfitPrice);
        if (tpResult.success && tpResult.orderId) {
          tpOrderId = tpResult.orderId;
          console.log(`  ✅ Take Profit order placed: ${tpOrderId}`);
          break;
        } else if (tpResult.error?.includes('not enough balance')) {
          console.log(`  ⚠️ TP attempt ${attempt + 1}/2: allowance not ready, watchdog will retry`);
          continue;
        } else {
          console.log(`  ⚠️ Take Profit order failed: ${tpResult.error}`);
          break;
        }
      } catch (err: any) {
        errorLogger.logError('Bot.placeTP', err, { asset: asset?.slice(0, 30), entryPrice, shares });
        console.error(`  ⚠️ Take Profit order error: ${err?.message}`);
        break;
      }
    }

    // Save order ID to state so we can cancel it later
    if (tpOrderId) {
      this.stateManager.setProtectionOrders(asset, undefined, tpOrderId);
    }
  }

  /**
   * Place TP orders for existing positions that don't have them.
   * Called on startup to cover positions opened before TP feature was added.
   */
  private async placeProtectionOrdersForExistingPositions(): Promise<void> {
    if (!this.trader || this.config.dryRun) return;

    const positions = this.stateManager.getAllPositions().filter(p => p.size > 0.001);
    if (positions.length === 0) return;

    // Find positions missing TP orders
    const missing = positions.filter(p => {
      const { takeProfitOrderId } = this.stateManager.getProtectionOrders(p.asset);
      return !takeProfitOrderId;
    });

    if (missing.length === 0) {
      console.log(`[Startup] All ${positions.length} positions already have TP orders`);
      return;
    }

    console.log(`[Startup] Placing TP orders for ${missing.length}/${positions.length} positions...`);

    let placed = 0;
    for (const pos of missing) {
      if (!this.isRunning && placed > 0) break; // Stop if shutting down
      try {
        // Skip positions too small for Polymarket minimum (~1 share)
        if (pos.size < 1) continue;

        const tpPercent = this.config.takeProfitPercent / 100;
        const takeProfitPrice = Math.min(0.99, Math.round((pos.avgPrice * (1 + tpPercent)) * 100) / 100);

        if (takeProfitPrice <= pos.avgPrice) continue;

        // Update balance allowance and retry with delay
        let tpPlaced = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          await this.trader.updateBalanceAllowance(pos.asset);
          await this.delay(2000);

          const tpResult = await this.trader.placeLimitOrder(pos.asset, 'SELL', pos.size, takeProfitPrice);
          if (tpResult.success && tpResult.orderId) {
            this.stateManager.setProtectionOrders(pos.asset, undefined, tpResult.orderId);
            placed++;
            tpPlaced = true;
            console.log(`  TP placed: ${pos.title?.slice(0, 40)} | SELL @ $${takeProfitPrice} (${pos.size.toFixed(2)} shares)`);
            break;
          } else if (tpResult.error?.includes('not enough balance')) {
            console.log(`  TP retry ${attempt + 1}: ${pos.title?.slice(0, 40)} | allowance not ready`);
            continue;
          } else {
            console.log(`  TP failed: ${pos.title?.slice(0, 40)} | ${tpResult.error}`);
            break;
          }
        }
      } catch (err: any) {
        console.log(`  TP error: ${pos.title?.slice(0, 40)} | ${err?.message}`);
      }
    }

    console.log(`[Startup] Placed ${placed}/${missing.length} TP orders`);
  }

  /**
   * Cancel any SL/TP protection orders for a position.
   * Called before selling a position (to avoid double-selling).
   */
  private async cancelProtectionOrders(asset: string): Promise<void> {
    if (!this.trader) return;

    const { stopLossOrderId, takeProfitOrderId } = this.stateManager.getProtectionOrders(asset);
    const orderIds = [stopLossOrderId, takeProfitOrderId].filter(Boolean) as string[];

    if (orderIds.length > 0) {
      console.log(`  🗑️ Cancelling ${orderIds.length} protection order(s)...`);
      await this.trader.cancelOrders(orderIds);
      this.stateManager.clearProtectionOrders(asset);
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

    // Cancel SL/TP protection orders first
    await this.cancelProtectionOrders(asset);

    try {
      // Get current bid price for the sell
      const spread = await this.clobApi.getSpread(asset);
      const price = Math.max(0.01, parseFloat(spread.bid || '0.5'));

      // Use dedicated sellPosition method (passes shares correctly, uses FAK)
      const result = await this.trader.sellPosition(
        asset,
        position.size,
        price,
        position.title,
      );

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
        const sellAmount = (result.details?.size || position.size) * (result.details?.price || price);
        this.stateManager.recordTrade(true, sellAmount);

        // Update dashboard last trade time
        if (this.dashboardServer) {
          this.dashboardServer.updateLastTradeTime();
        }

        // Send notification
        await this.notifier.notifyTradeExecuted({
          side: 'SELL',
          title: position.title,
          outcome: position.outcome,
          amount: sellAmount,
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
      errorLogger.logError('Bot.forceSell', err, { asset: asset?.slice(0, 30) });
      console.error('[Dashboard] Force sell failed:', err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Sell all open positions (called from dashboard)
   */
  private async sellAllPositions(): Promise<{ success: boolean; sold: number; failed: number; errors: string[] }> {
    const positions = this.stateManager.getAllPositions().filter(p => p.size > 0.001);
    if (positions.length === 0) {
      return { success: true, sold: 0, failed: 0, errors: [] };
    }

    if (!this.trader) {
      return { success: false, sold: 0, failed: positions.length, errors: ['Trader not initialized'] };
    }

    console.log(`\n[Dashboard] Selling ALL ${positions.length} positions...`);

    // Cancel all open orders first (TP orders etc)
    try {
      await this.trader.cancelAllOrders();
      // Clear all protection order IDs
      for (const pos of positions) {
        this.stateManager.clearProtectionOrders(pos.asset);
      }
    } catch (err: any) {
      console.warn('[Dashboard] Failed to cancel orders before sell-all:', err?.message);
    }

    let sold = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const pos of positions) {
      try {
        const result = await this.forceSellPosition(pos.asset);
        if (result.success) {
          sold++;
        } else {
          failed++;
          errors.push(`${pos.title?.slice(0, 30)}: ${result.error}`);
        }
      } catch (err: any) {
        failed++;
        errors.push(`${pos.title?.slice(0, 30)}: ${err?.message}`);
      }
    }

    console.log(`[Dashboard] Sell All complete: ${sold} sold, ${failed} failed`);

    if (this.notifier) {
      await this.notifier.notify(
        `<b>Sell All:</b> ${sold} sold, ${failed} failed out of ${positions.length} positions`
      );
    }

    return { success: true, sold, failed, errors };
  }

  /**
   * Cancel all open orders on the exchange (called from dashboard)
   */
  private async cancelAllOpenOrders(): Promise<{ success: boolean; message: string }> {
    if (!this.trader) {
      return { success: false, message: 'Trader not initialized' };
    }

    try {
      await this.trader.cancelAllOrders();

      // Clear all protection order IDs from state
      const positions = this.stateManager.getAllPositions();
      for (const pos of positions) {
        this.stateManager.clearProtectionOrders(pos.asset);
      }

      console.log('[Dashboard] All orders cancelled');
      return { success: true, message: 'All open orders cancelled' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to cancel orders' };
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

    if (this.watchdog) {
      this.watchdog.stop();
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
