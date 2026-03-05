import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

  // Daily P&L tracking
  dailyPnL: number; // Cumulative P&L for the current day (in USD)
  dailyPnLDate: string; // Date in YYYY-MM-DD format (UTC)

  // Version for migration
  version: number;
}

const STATE_VERSION = 2;
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
    metadata?: { title?: string; outcome?: string; slug?: string }
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
          existing.avgPrice = ((existing.avgPrice * existing.size) + (price * sizeDelta)) / newSize;
        }
        existing.size = newSize;
      }
    } else if (sizeDelta > 0) {
      // New position
      this.state.positions[asset] = {
        asset,
        size: sizeDelta,
        avgPrice: price,
        title: metadata?.title || 'Unknown',
        outcome: metadata?.outcome || 'Unknown',
        slug: metadata?.slug || '',
        entryTime: Date.now(),
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
}
