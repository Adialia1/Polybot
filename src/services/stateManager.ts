import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface TraderStats {
  totalPnL: number;
  totalTrades: number;
  wins: number; // trades with profit > 0
  losses: number;
  avgHoldTimeMs: number;
  totalHoldTimeMs: number; // used for calculating average
}

export interface BotState {
  // Positions we're tracking locally
  positions: {
    [asset: string]: {
      asset: string;
      size: number;
      avgPrice: number;
      title: string;
      outcome: string;
      slug: string;
      entryTime: number;
      walletAlias?: string; // Track which trader opened this position
      conditionId?: string; // Market condition ID (needed for on-chain redemption)
      totalCost?: number; // Running total of actual USD spent on buys (reliable position cap)
      highestPrice?: number; // Highest price reached for trailing stop
      stopLossOrderId?: string; // GTC limit order ID for stop loss
      takeProfitOrderId?: string; // GTC limit order ID for take profit
    };
  };

  // Pending/recent orders
  orders: {
    id: string;
    asset: string;
    side: 'BUY' | 'SELL';
    amount: number;
    status: string;
    createdAt: number;
    processedAt?: number;
    result?: any;
    walletAlias: string;
  }[];

  // Last seen trade timestamps per wallet (to avoid duplicate processing)
  lastSeenTrades: {
    [walletAddress: string]: number;
  };

  // Bot stats
  stats: {
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    totalVolume: number;
    startTime: number;
    lastUpdateTime: number;
  };

  // Per-trader performance tracking
  traderStats: {
    [walletAlias: string]: TraderStats;
  };

  // Daily P&L tracking
  dailyPnL: number; // Cumulative P&L for the current day (in USD)
  dailyPnLDate: string; // Date in YYYY-MM-DD format (UTC)

  // Version for migration
  version: number;
}

const STATE_VERSION = 3;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = join(__dirname, '../../data/state.json');

export class StateManager {
  private state: BotState;
  private statePath: string;
  private saveInterval: NodeJS.Timeout | null = null;
  private isDirty = false;

  constructor(statePath?: string) {
    this.statePath = statePath || DEFAULT_STATE_PATH;
    this.state = this.loadState();
  }

  /**
   * Get current date in YYYY-MM-DD format (UTC)
   */
  private getCurrentUTCDate(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  private getDefaultState(): BotState {
    return {
      positions: {},
      orders: [],
      lastSeenTrades: {},
      stats: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalVolume: 0,
        startTime: Date.now(),
        lastUpdateTime: Date.now(),
      },
      traderStats: {},
      dailyPnL: 0,
      dailyPnLDate: this.getCurrentUTCDate(),
      version: STATE_VERSION,
    };
  }

  private loadState(): BotState {
    try {
      if (existsSync(this.statePath)) {
        const data = readFileSync(this.statePath, 'utf-8');
        const state = JSON.parse(data) as BotState;

        // Migration if needed
        if (state.version !== STATE_VERSION) {
          console.log('[StateManager] Migrating state from version', state.version);

          // Migration from v1 to v2: Add daily P&L tracking
          if (!state.dailyPnL && state.dailyPnL !== 0) {
            state.dailyPnL = 0;
          }
          if (!state.dailyPnLDate) {
            state.dailyPnLDate = this.getCurrentUTCDate();
          }

          // Migration from v2 to v3: Add per-trader stats
          if (!state.traderStats) {
            state.traderStats = {};
          }

          state.version = STATE_VERSION;
        }

        console.log('[StateManager] Loaded state from', this.statePath);
        console.log(`  Positions: ${Object.keys(state.positions).length}`);
        console.log(`  Orders: ${state.orders.length}`);
        console.log(`  Total trades: ${state.stats.totalTrades}`);

        return state;
      }
    } catch (error) {
      console.error('[StateManager] Failed to load state:', error);
    }

    console.log('[StateManager] Starting with fresh state');
    return this.getDefaultState();
  }

  saveState(): void {
    try {
      // Ensure directory exists
      const dir = dirname(this.statePath);
      if (!existsSync(dir)) {
        const { mkdirSync } = require('fs');
        mkdirSync(dir, { recursive: true });
      }

      this.state.stats.lastUpdateTime = Date.now();
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
      this.isDirty = false;
      console.log('[StateManager] State saved');
    } catch (error) {
      console.error('[StateManager] Failed to save state:', error);
    }
  }

  // Start auto-save interval
  startAutoSave(intervalMs: number = 30000): void {
    this.saveInterval = setInterval(() => {
      if (this.isDirty) {
        this.saveState();
      }
    }, intervalMs);
    console.log(`[StateManager] Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  stopAutoSave(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    // Save on stop
    this.saveState();
  }

  // Position management
  getPosition(asset: string) {
    return this.state.positions[asset];
  }

  getAllPositions() {
    return Object.values(this.state.positions);
  }

  updatePosition(
    asset: string,
    sizeDelta: number,
    price: number,
    metadata?: { title?: string; outcome?: string; slug?: string; conditionId?: string }
  ): void {
    const existing = this.state.positions[asset];

    if (existing) {
      const newSize = existing.size + sizeDelta;

      if (newSize <= 0.0001) {
        // Position closed
        delete this.state.positions[asset];
        console.log(`[StateManager] Position closed: ${existing.title}`);
      } else {
        // Update position
        if (sizeDelta > 0) {
          // Track actual dollars spent (must compute before avgPrice update)
          const previousCost = existing.totalCost || (existing.size * existing.avgPrice);
          existing.totalCost = previousCost + (price * sizeDelta);
          existing.avgPrice = ((existing.avgPrice * existing.size) + (price * sizeDelta)) / newSize;
        }
        existing.size = newSize;
      }
    } else if (sizeDelta > 0) {
      // New position - initialize highestPrice to avgPrice so trailing stop can track from entry
      this.state.positions[asset] = {
        asset,
        size: sizeDelta,
        avgPrice: price,
        totalCost: price * sizeDelta, // Track actual dollars spent from the start
        conditionId: metadata?.conditionId,
        title: metadata?.title || 'Unknown',
        outcome: metadata?.outcome || 'Unknown',
        slug: metadata?.slug || '',
        entryTime: Date.now(),
        highestPrice: price, // Initialize to entry price so trailing stop works immediately
      };
      console.log(`[StateManager] New position: ${metadata?.title}`);
    }

    this.isDirty = true;
  }

  hasPosition(asset: string): boolean {
    return asset in this.state.positions;
  }

  getPositionSize(asset: string): number {
    return this.state.positions[asset]?.size || 0;
  }

  /**
   * Get total dollars spent on a position (reliable for position cap checks).
   * Falls back to size * avgPrice for positions created before totalCost was tracked.
   */
  getPositionTotalCost(asset: string): number {
    const pos = this.state.positions[asset];
    if (!pos) return 0;
    return pos.totalCost || (pos.size * pos.avgPrice);
  }

  /**
   * Get the count of open positions (positions with size > 0)
   */
  getOpenPositionsCount(): number {
    return Object.values(this.state.positions).filter(p => p.size > 0).length;
  }

  // Order management
  addOrder(order: BotState['orders'][0]): void {
    this.state.orders.push(order);
    // Keep only last 100 orders
    if (this.state.orders.length > 100) {
      this.state.orders = this.state.orders.slice(-100);
    }
    this.isDirty = true;
  }

  updateOrder(orderId: string, updates: Partial<BotState['orders'][0]>): void {
    const order = this.state.orders.find(o => o.id === orderId);
    if (order) {
      Object.assign(order, updates);
      this.isDirty = true;
    }
  }

  getRecentOrders(limit: number = 10) {
    return this.state.orders.slice(-limit);
  }

  getPendingOrders() {
    return this.state.orders.filter(o => o.status === 'pending' || o.status === 'processing');
  }

  // Last seen trade tracking (to avoid duplicates after restart)
  getLastSeenTrade(walletAddress: string): number {
    return this.state.lastSeenTrades[walletAddress.toLowerCase()] || 0;
  }

  setLastSeenTrade(walletAddress: string, timestamp: number): void {
    this.state.lastSeenTrades[walletAddress.toLowerCase()] = timestamp;
    this.isDirty = true;
  }

  // Stats
  recordTrade(success: boolean, volume: number): void {
    this.state.stats.totalTrades++;
    if (success) {
      this.state.stats.successfulTrades++;
    } else {
      this.state.stats.failedTrades++;
    }
    this.state.stats.totalVolume += volume;
    this.isDirty = true;
  }

  getStats() {
    return { ...this.state.stats };
  }

  // Sync positions from API (merge with local state)
  syncPositionsFromApi(apiPositions: any[]): void {
    // Update existing positions with fresh data
    for (const pos of apiPositions) {
      if (this.state.positions[pos.asset]) {
        // Update size from API (source of truth)
        this.state.positions[pos.asset].size = pos.size;
      } else {
        // Position exists on API but not locally - add it
        this.state.positions[pos.asset] = {
          asset: pos.asset,
          size: pos.size,
          avgPrice: pos.avgPrice || 0,
          title: pos.title,
          outcome: pos.outcome,
          slug: pos.slug,
          entryTime: Date.now(),
        };
      }
    }

    // Remove local positions that don't exist on API
    const apiAssets = new Set(apiPositions.map(p => p.asset));
    for (const asset of Object.keys(this.state.positions)) {
      if (!apiAssets.has(asset)) {
        delete this.state.positions[asset];
      }
    }

    this.isDirty = true;
  }

  // Export full state (for debugging)
  exportState(): BotState {
    return JSON.parse(JSON.stringify(this.state));
  }

  // ============================================
  // Daily P&L tracking methods
  // ============================================

  /**
   * Check if the date has changed (midnight UTC rollover)
   * If so, reset daily P&L to 0
   */
  private checkAndResetDailyPnL(): void {
    const currentDate = this.getCurrentUTCDate();
    if (this.state.dailyPnLDate !== currentDate) {
      console.log(`[StateManager] New day detected (${currentDate}), resetting daily P&L from $${this.state.dailyPnL.toFixed(2)}`);
      this.state.dailyPnL = 0;
      this.state.dailyPnLDate = currentDate;
      this.isDirty = true;
    }
  }

  /**
   * Update daily P&L after a trade
   * @param pnlChange - The P&L change from this trade (positive = profit, negative = loss)
   */
  updateDailyPnL(pnlChange: number): void {
    // Check for date rollover first
    this.checkAndResetDailyPnL();

    this.state.dailyPnL += pnlChange;
    this.isDirty = true;

    console.log(`[StateManager] Daily P&L updated: ${pnlChange >= 0 ? '+' : ''}$${pnlChange.toFixed(2)} (total: $${this.state.dailyPnL.toFixed(2)})`);
  }

  /**
   * Get the current daily P&L
   * @returns The cumulative P&L for today
   */
  getDailyPnL(): number {
    // Check for date rollover first
    this.checkAndResetDailyPnL();
    return this.state.dailyPnL;
  }

  /**
   * Check if the daily loss limit has been exceeded
   * @param dailyLossLimit - The maximum allowed daily loss (positive number, e.g., 10 = $10 loss limit)
   * @returns true if limit exceeded (P&L is below -dailyLossLimit), false otherwise
   */
  isDailyLossLimitExceeded(dailyLossLimit: number): boolean {
    // If limit is 0 or negative, feature is disabled
    if (dailyLossLimit <= 0) {
      return false;
    }

    // Check for date rollover first
    this.checkAndResetDailyPnL();

    // Daily loss limit is exceeded if P&L goes below the negative of the limit
    // e.g., if limit is 10, we stop trading if dailyPnL < -10
    return this.state.dailyPnL < -dailyLossLimit;
  }

  /**
   * Get the daily P&L date
   * @returns The current date being tracked (YYYY-MM-DD format)
   */
  getDailyPnLDate(): string {
    return this.state.dailyPnLDate;
  }

  // ============================================
  // Trailing Stop Loss methods
  // ============================================

  /**
   * Update the highest price reached for a position (for trailing stop)
   * Only updates if currentPrice > existing highestPrice and currentPrice > avgPrice
   * @param asset - The asset token ID
   * @param currentPrice - The current market price
   * @returns true if highestPrice was updated, false otherwise
   */
  updateHighestPrice(asset: string, currentPrice: number): boolean {
    const position = this.state.positions[asset];
    if (!position) return false;

    // Only track highest price when position is in profit
    // This prevents trailing stop from triggering on normal spread/volatility
    // or on resolved markets with $0.01 bids
    if (currentPrice <= position.avgPrice) {
      return false;
    }

    const existingHighest = position.highestPrice || position.avgPrice;
    if (currentPrice > existingHighest) {
      position.highestPrice = currentPrice;
      this.isDirty = true;
      return true;
    }
    return false;
  }

  /**
   * Check if trailing stop should be triggered for a position
   * @param asset - The asset token ID
   * @param currentPrice - The current market price
   * @param trailingStopPercent - The trailing stop percentage (e.g., 15 = sell if price drops 15% from peak)
   * @returns Object with triggered status and details
   */
  checkTrailingStop(
    asset: string,
    currentPrice: number,
    trailingStopPercent: number
  ): { triggered: boolean; dropPercent?: number; highestPrice?: number; avgPrice?: number } {
    const position = this.state.positions[asset];
    if (!position) return { triggered: false };

    const highestPrice = position.highestPrice;

    // Only trigger trailing stop if position was in profit at some point
    // (highestPrice is only set when price exceeds avgPrice)
    if (!highestPrice || highestPrice <= position.avgPrice) {
      return { triggered: false };
    }

    // Calculate drop from peak
    const dropPercent = ((highestPrice - currentPrice) / highestPrice) * 100;

    // Trigger if price dropped more than threshold from the peak
    if (dropPercent >= trailingStopPercent) {
      return {
        triggered: true,
        dropPercent,
        highestPrice,
        avgPrice: position.avgPrice,
      };
    }

    return {
      triggered: false,
      dropPercent,
      highestPrice,
      avgPrice: position.avgPrice,
    };
  }

  /**
   * Get the highest price for a position
   * @param asset - The asset token ID
   * @returns The highest price, or undefined if not tracked
   */
  getHighestPrice(asset: string): number | undefined {
    return this.state.positions[asset]?.highestPrice;
  }

  // ============================================
  // Per-Trader Performance Tracking
  // ============================================

  /**
   * Record a completed trade for a specific trader
   * @param walletAlias - The trader's wallet alias
   * @param pnl - The P&L from the trade (positive = profit, negative = loss)
   * @param holdTimeMs - How long the position was held in milliseconds
   */
  recordTraderTrade(walletAlias: string, pnl: number, holdTimeMs: number): void {
    if (!this.state.traderStats[walletAlias]) {
      this.state.traderStats[walletAlias] = {
        totalPnL: 0,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        avgHoldTimeMs: 0,
        totalHoldTimeMs: 0,
      };
    }

    const stats = this.state.traderStats[walletAlias];
    stats.totalPnL += pnl;
    stats.totalTrades++;
    stats.totalHoldTimeMs += holdTimeMs;
    stats.avgHoldTimeMs = stats.totalHoldTimeMs / stats.totalTrades;

    if (pnl > 0) {
      stats.wins++;
    } else if (pnl < 0) {
      stats.losses++;
    }
    // pnl === 0 is neither a win nor a loss

    this.isDirty = true;

    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
    console.log(`[StateManager] Trader ${walletAlias} trade recorded: P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Total P&L: $${stats.totalPnL.toFixed(2)} | Win Rate: ${winRate}%`);
  }

  /**
   * Get stats for a specific trader
   * @param walletAlias - The trader's wallet alias
   * @returns The trader's stats or undefined if not found
   */
  getTraderStats(walletAlias: string): TraderStats | undefined {
    return this.state.traderStats[walletAlias];
  }

  /**
   * Get stats for all traders
   * @returns Object with all trader stats keyed by wallet alias
   */
  getAllTraderStats(): { [walletAlias: string]: TraderStats } {
    return { ...this.state.traderStats };
  }

  /**
   * Format hold time in human-readable format
   * @param holdTimeMs - Hold time in milliseconds
   * @returns Formatted string (e.g., "2h 15m" or "45m")
   */
  static formatHoldTime(holdTimeMs: number): string {
    const totalMinutes = Math.floor(holdTimeMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  /**
   * Set the SL/TP order IDs for a position
   */
  setProtectionOrders(asset: string, stopLossOrderId?: string, takeProfitOrderId?: string): void {
    if (this.state.positions[asset]) {
      if (stopLossOrderId) this.state.positions[asset].stopLossOrderId = stopLossOrderId;
      if (takeProfitOrderId) this.state.positions[asset].takeProfitOrderId = takeProfitOrderId;
      this.isDirty = true;
    }
  }

  /**
   * Get the SL/TP order IDs for a position
   */
  getProtectionOrders(asset: string): { stopLossOrderId?: string; takeProfitOrderId?: string } {
    const pos = this.state.positions[asset];
    return {
      stopLossOrderId: pos?.stopLossOrderId,
      takeProfitOrderId: pos?.takeProfitOrderId,
    };
  }

  /**
   * Clear the SL/TP order IDs for a position (called after cancellation)
   */
  clearProtectionOrders(asset: string): void {
    if (this.state.positions[asset]) {
      delete this.state.positions[asset].stopLossOrderId;
      delete this.state.positions[asset].takeProfitOrderId;
      this.isDirty = true;
    }
  }

  /**
   * Set the wallet alias for a position (used when opening new positions)
   * @param asset - The asset ID
   * @param walletAlias - The trader's wallet alias
   */
  setPositionWalletAlias(asset: string, walletAlias: string): void {
    if (this.state.positions[asset]) {
      this.state.positions[asset].walletAlias = walletAlias;
      this.isDirty = true;
    }
  }
}
