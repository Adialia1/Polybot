import { StateManager } from './stateManager.js';
import { Trader } from './trader.js';
import { ClobApiClient } from '../api/clobApi.js';
import { WalletConfig } from '../types/index.js';
import { errorLogger } from './errorLogger.js';

export interface ReconcilerConfig {
  stateManager: StateManager;
  trader: Trader | null;
  trackedWallets: WalletConfig[];
  dryRun: boolean;
}

export interface ReconciliationResult {
  checkedPositions: number;
  orphanedPositions: number;
  soldPositions: number;
  errors: string[];
}

export class PositionReconciler {
  private stateManager: StateManager;
  private trader: Trader | null;
  private trackedWallets: WalletConfig[];
  private dryRun: boolean;
  private clobApi: ClobApiClient;

  constructor(config: ReconcilerConfig) {
    this.stateManager = config.stateManager;
    this.trader = config.trader;
    this.trackedWallets = config.trackedWallets;
    this.dryRun = config.dryRun;
    this.clobApi = new ClobApiClient();
  }

  /**
   * Reconcile our positions with the traders we copy.
   * If a trader has sold a position we still hold, sell it.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      checkedPositions: 0,
      orphanedPositions: 0,
      soldPositions: 0,
      errors: [],
    };

    const ourPositions = this.stateManager.getAllPositions();
    if (ourPositions.length === 0) {
      console.log('[Reconciler] No positions to reconcile');
      return result;
    }

    console.log(`[Reconciler] Checking ${ourPositions.length} position(s) against tracked traders...`);

    // Get all trader positions
    const traderPositions = new Map<string, Set<string>>(); // wallet -> set of assets

    for (const wallet of this.trackedWallets) {
      if (!wallet.enabled) continue;

      try {
        const positions = await this.fetchTraderPositions(wallet.address);
        const assets = new Set(positions.map(p => p.asset));
        traderPositions.set(wallet.address.toLowerCase(), assets);
        console.log(`[Reconciler] ${wallet.alias}: ${positions.length} active positions`);
      } catch (error: any) {
        errorLogger.logError('Reconciler.fetchPositions', error, { wallet: wallet.alias });
        console.error(`[Reconciler] Failed to fetch positions for ${wallet.alias}:`, error);
        result.errors.push(`Failed to fetch ${wallet.alias} positions`);
      }
    }

    // Check each of our positions
    for (const position of ourPositions) {
      result.checkedPositions++;

      // Check if ANY tracked trader still holds this position
      let traderStillHolds = false;

      for (const [walletAddr, assets] of traderPositions.entries()) {
        if (assets.has(position.asset)) {
          traderStillHolds = true;
          break;
        }
      }

      if (!traderStillHolds) {
        console.log(`\n[Reconciler] ⚠️  ORPHANED POSITION DETECTED:`);
        console.log(`  Market: ${position.title}`);
        console.log(`  Outcome: ${position.outcome}`);
        console.log(`  Size: ${position.size.toFixed(4)} shares`);
        console.log(`  Reason: No tracked trader holds this position anymore`);

        result.orphanedPositions++;

        // Sell the orphaned position
        if (this.trader && !this.dryRun) {
          try {
            console.log(`[Reconciler] Selling orphaned position...`);
            await this.sellPosition(position);
            result.soldPositions++;
            console.log(`[Reconciler] ✅ Position sold`);
          } catch (error: any) {
            errorLogger.logError('Reconciler.sell', error, { title: position.title?.slice(0, 40) });
            console.error(`[Reconciler] Failed to sell:`, error?.message || error);
            result.errors.push(`Failed to sell ${position.title}`);
          }
        } else if (this.dryRun) {
          console.log(`[Reconciler] DRY RUN - Would sell this position`);
        }
      }
    }

    // Summary
    console.log(`\n[Reconciler] Reconciliation complete:`);
    console.log(`  Checked: ${result.checkedPositions} positions`);
    console.log(`  Orphaned: ${result.orphanedPositions}`);
    console.log(`  Sold: ${result.soldPositions}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }

    return result;
  }

  private async fetchTraderPositions(walletAddress: string): Promise<any[]> {
    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${walletAddress.toLowerCase()}`
    );

    if (!res.ok) {
      throw new Error(`API returned ${res.status}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  private async sellPosition(position: { asset: string; size: number; title: string; outcome: string }): Promise<void> {
    if (!this.trader) {
      throw new Error('Trader not initialized');
    }

    // Cancel any SL/TP protection orders before selling
    const { stopLossOrderId, takeProfitOrderId } = this.stateManager.getProtectionOrders(position.asset);
    const orderIds = [stopLossOrderId, takeProfitOrderId].filter(Boolean) as string[];
    if (orderIds.length > 0) {
      console.log(`[Reconciler] Cancelling ${orderIds.length} protection order(s)...`);
      await this.trader.cancelOrders(orderIds);
      this.stateManager.clearProtectionOrders(position.asset);
    }

    // Get current best bid price
    const book = await this.clobApi.getOrderBook(position.asset);
    const bestBid = parseFloat(book.bids?.[0]?.price || '0.5');
    const sellPrice = Math.max(0.01, bestBid);

    // Use dedicated sellPosition method (passes shares correctly, uses FAK)
    const result = await this.trader.sellPosition(
      position.asset,
      position.size,
      sellPrice,
      position.title,
    );

    if (!result.success) {
      throw new Error(result.error || 'Unknown error');
    }

    // Update state
    this.stateManager.updatePosition(position.asset, -position.size, sellPrice);
  }

  /**
   * Check if a specific position is still held by any tracked trader
   */
  async isPositionOrphaned(asset: string): Promise<boolean> {
    for (const wallet of this.trackedWallets) {
      if (!wallet.enabled) continue;

      try {
        const positions = await this.fetchTraderPositions(wallet.address);
        const hasPosition = positions.some(p => p.asset === asset);
        if (hasPosition) {
          return false;
        }
      } catch (error) {
        // If we can't check, assume not orphaned
        console.error(`[Reconciler] Error checking ${wallet.alias}:`, error);
      }
    }

    return true;
  }
}
