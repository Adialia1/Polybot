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

    const enabledWallets = this.trackedWallets.filter(w => w.enabled);

    // Check each of our positions individually (much faster than fetching all trader positions)
    for (const position of ourPositions) {
      result.checkedPositions++;

      // Check if ANY tracked trader still holds this specific asset
      let traderStillHolds = false;

      for (const wallet of enabledWallets) {
        try {
          const holds = await this.traderHoldsAsset(wallet.address, position.asset);
          if (holds) {
            traderStillHolds = true;
            break;
          }
        } catch (error: any) {
          // If we can't check, assume trader still holds (safer than selling)
          console.warn(`[Reconciler] Failed to check ${wallet.alias} for ${position.title?.slice(0, 30)}: ${error?.message}`);
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

  /**
   * Check if a specific trader holds a specific asset.
   * Uses asset filter to avoid fetching all 1000+ positions.
   */
  private async traderHoldsAsset(walletAddress: string, asset: string): Promise<boolean> {
    const url = `https://data-api.polymarket.com/positions?user=${walletAddress.toLowerCase()}&asset=${asset}&limit=1`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`API returned ${res.status}`);
    }

    const data = await res.json();
    const positions = Array.isArray(data) ? data : [];
    // Check if trader has a non-zero position in this asset
    return positions.some(p => parseFloat(p.size) > 0.001);
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

    // Get current best bid price (safe: returns null if market resolved / orderbook gone)
    const book = await this.clobApi.getOrderBookSafe(position.asset);
    if (!book) {
      console.log(`[Reconciler] No orderbook for ${position.title || position.asset.slice(0, 20)} — market likely resolved, skipping sell`);
      return;
    }
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
        const holds = await this.traderHoldsAsset(wallet.address, asset);
        if (holds) return false;
      } catch (error) {
        // If we can't check, assume not orphaned (safer)
        console.error(`[Reconciler] Error checking ${wallet.alias}:`, error);
        return false;
      }
    }

    return true;
  }
}
