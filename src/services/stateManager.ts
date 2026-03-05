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

  // Version for migration
  version: number;
}

const STATE_VERSION = 1;
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
          // Add migration logic here if needed
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
}
