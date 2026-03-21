import { EventEmitter } from 'events';

export interface Position {
  asset: string;           // Token ID
  size: number;            // Number of shares
  avgPrice: number;        // Average entry price
  currentPrice: number;    // Current market price
  value: number;           // Current value in USD
  title: string;           // Market title
  outcome: string;         // Yes/No or outcome name
  slug: string;            // Market slug
}

export interface PositionManagerConfig {
  proxyWallet: string;
  syncIntervalMs?: number; // How often to sync with API (default: 30s)
}

export class PositionManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private proxyWallet: string;
  private syncInterval: NodeJS.Timeout | null = null;
  private syncIntervalMs: number;
  private isInitialized = false;

  constructor(config: PositionManagerConfig) {
    super();
    this.proxyWallet = config.proxyWallet.toLowerCase();
    this.syncIntervalMs = config.syncIntervalMs || 30000;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[PositionManager] Initializing...');
    await this.syncPositions();

    // Start periodic sync
    this.syncInterval = setInterval(() => {
      this.syncPositions().catch(err => {
        console.error('[PositionManager] Sync error:', err);
      });
    }, this.syncIntervalMs);

    this.isInitialized = true;
    console.log('[PositionManager] Initialized with', this.positions.size, 'positions');
  }

  async syncPositions(): Promise<void> {
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/positions?user=${this.proxyWallet}`
      );
      const data = await res.json();

      if (!Array.isArray(data)) {
        console.error('[PositionManager] Invalid positions response');
        return;
      }

      // Update positions map
      const newPositions = new Map<string, Position>();

      for (const pos of data) {
        newPositions.set(pos.asset, {
          ...pos,
          asset: pos.asset,
          size: pos.size,
          avgPrice: pos.avgPrice || 0,
          currentPrice: pos.curPrice || 0,
          value: pos.size * (pos.curPrice || 0),
          title: pos.title,
          outcome: pos.outcome,
          slug: pos.slug,
        });
      }

      this.positions = newPositions;
      this.emit('sync', this.getPositions());
    } catch (error) {
      console.error('[PositionManager] Failed to sync positions:', error);
    }
  }

  // Check if we have a position for a given asset
  hasPosition(asset: string): boolean {
    return this.positions.has(asset);
  }

  // Get position for an asset
  getPosition(asset: string): Position | undefined {
    return this.positions.get(asset);
  }

  // Get all positions
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  // Get total portfolio value
  getTotalValue(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.value;
    }
    return total;
  }

  // Update position after a trade (local update before API sync)
  updatePositionLocal(asset: string, sizeDelta: number, price: number, metadata?: Partial<Position>): void {
    const existing = this.positions.get(asset);

    if (existing) {
      const newSize = existing.size + sizeDelta;

      if (newSize <= 0) {
        // Position closed
        this.positions.delete(asset);
        console.log(`[PositionManager] Position closed: ${existing.title}`);
      } else {
        // Update position
        const newAvgPrice = sizeDelta > 0
          ? ((existing.avgPrice * existing.size) + (price * sizeDelta)) / newSize
          : existing.avgPrice;

        existing.size = newSize;
        existing.avgPrice = newAvgPrice;
        existing.value = newSize * existing.currentPrice;
        console.log(`[PositionManager] Position updated: ${existing.title} -> ${newSize.toFixed(4)} shares`);
      }
    } else if (sizeDelta > 0) {
      // New position
      const newPos: Position = {
        asset,
        size: sizeDelta,
        avgPrice: price,
        currentPrice: price,
        value: sizeDelta * price,
        title: metadata?.title || 'Unknown',
        outcome: metadata?.outcome || 'Unknown',
        slug: metadata?.slug || '',
      };
      this.positions.set(asset, newPos);
      console.log(`[PositionManager] New position: ${newPos.title} -> ${sizeDelta.toFixed(4)} shares`);
    }

    this.emit('update', this.getPositions());
  }

  // Check if we can sell a position
  canSell(asset: string, size: number): { canSell: boolean; availableSize: number; reason?: string } {
    const position = this.positions.get(asset);

    if (!position) {
      return {
        canSell: false,
        availableSize: 0,
        reason: 'No position found for this asset',
      };
    }

    if (position.size < size) {
      return {
        canSell: true, // Can sell, but only partial
        availableSize: position.size,
        reason: `Only have ${position.size.toFixed(4)} shares (requested ${size.toFixed(4)})`,
      };
    }

    return {
      canSell: true,
      availableSize: position.size,
    };
  }

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    console.log('[PositionManager] Stopped');
  }

  // Print current positions
  printPositions(): void {
    console.log('\n[PositionManager] Current Positions:');
    if (this.positions.size === 0) {
      console.log('  No positions');
      return;
    }

    for (const pos of this.positions.values()) {
      console.log(`  ${pos.title}`);
      console.log(`    ${pos.outcome}: ${pos.size.toFixed(4)} shares @ $${pos.currentPrice.toFixed(3)}`);
      console.log(`    Value: $${pos.value.toFixed(2)}`);
    }
    console.log(`  Total: $${this.getTotalValue().toFixed(2)}\n`);
  }
}
