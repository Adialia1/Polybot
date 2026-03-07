/**
 * Position Reconciliation Test Script
 *
 * Tests the complete flow of detecting and handling:
 * 1. A tracked trader sells a position we still hold
 * 2. A position is manually closed by the user on the Polymarket website
 * 3. Order cleanup when positions are closed
 *
 * Run: npx tsx src/scripts/testReconciliation.ts
 *   or: npm run test-reconcile
 */

import 'dotenv/config';
import { StateManager } from '../services/stateManager.js';
import { PositionReconciler } from '../services/positionReconciler.js';
import { Trader } from '../services/trader.js';
import { loadConfig } from '../config.js';
import { WalletConfig } from '../types/index.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_PATH = join(process.cwd(), 'data', 'state.json');
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

// ============================================================
// Helpers
// ============================================================

interface OnChainPosition {
  asset: string;
  size: number;
  curPrice: number;
  avgPrice: number;
  title: string;
  outcome: string;
  slug: string;
  cashPnl: number;
  percentPnl: number;
  proxyWallet: string;
}

interface LocalPosition {
  asset: string;
  size: number;
  avgPrice: number;
  title: string;
  outcome: string;
  slug: string;
  entryTime: number;
  walletAlias?: string;
  highestPrice?: number;
}

async function fetchPositions(walletAddress: string): Promise<OnChainPosition[]> {
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${walletAddress.toLowerCase()}`
  );
  if (!res.ok) {
    throw new Error(`API returned ${res.status} for wallet ${walletAddress}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function truncateAsset(asset: string, len = 20): string {
  return asset.length > len ? asset.slice(0, len) + '...' : asset;
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function divider(title: string): void {
  console.log('');
  console.log('='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

// ============================================================
// Step 1: Show current state
// ============================================================

async function step1_showCurrentState(): Promise<{
  localPositions: LocalPosition[];
  onChainPositions: OnChainPosition[];
  ghostPositions: LocalPosition[];
  missingFromLocal: OnChainPosition[];
}> {
  divider('STEP 1: Current State Comparison');

  // Read local state
  let localPositions: LocalPosition[] = [];
  if (existsSync(STATE_PATH)) {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    localPositions = Object.values(state.positions || {}) as LocalPosition[];
  }

  console.log(`\n  Local state (data/state.json): ${localPositions.length} position(s)`);
  for (const pos of localPositions) {
    const value = pos.size * pos.avgPrice;
    console.log(`    - ${pos.title}`);
    console.log(`      ${pos.outcome} | ${pos.size.toFixed(4)} shares @ $${pos.avgPrice.toFixed(3)} | Value: $${value.toFixed(2)} | Trader: ${pos.walletAlias || 'unknown'}`);
  }

  // Fetch on-chain positions
  let onChainPositions: OnChainPosition[] = [];
  if (FUNDER_ADDRESS) {
    console.log(`\n  Fetching on-chain positions for ${FUNDER_ADDRESS}...`);
    try {
      onChainPositions = await fetchPositions(FUNDER_ADDRESS);
      console.log(`  On-chain (Polymarket API): ${onChainPositions.length} position(s)`);
      for (const pos of onChainPositions) {
        const value = pos.size * pos.curPrice;
        console.log(`    - ${pos.title}`);
        console.log(`      ${pos.outcome} | ${pos.size.toFixed(4)} shares @ $${(pos.curPrice || 0).toFixed(3)} | Value: $${value.toFixed(2)}`);
      }
    } catch (err: any) {
      console.error(`  Failed to fetch on-chain positions: ${err.message}`);
    }
  } else {
    console.log('\n  [!] FUNDER_ADDRESS not set - cannot fetch on-chain positions');
  }

  // Find discrepancies
  const onChainAssets = new Set(onChainPositions.map(p => p.asset));
  const localAssets = new Set(localPositions.map(p => p.asset));

  // Ghost positions: in state.json but NOT on-chain
  const ghostPositions = localPositions.filter(p => !onChainAssets.has(p.asset));

  // Missing from local: on-chain but NOT in state.json
  const missingFromLocal = onChainPositions.filter(p => !localAssets.has(p.asset));

  if (ghostPositions.length > 0) {
    console.log(`\n  [!] GHOST POSITIONS (in state.json but NOT on-chain): ${ghostPositions.length}`);
    for (const pos of ghostPositions) {
      console.log(`    - ${pos.title} (${pos.outcome}) - ${pos.size.toFixed(4)} shares`);
    }
  }

  if (missingFromLocal.length > 0) {
    console.log(`\n  [!] MISSING FROM LOCAL (on-chain but NOT in state.json): ${missingFromLocal.length}`);
    for (const pos of missingFromLocal) {
      console.log(`    - ${pos.title} (${pos.outcome}) - ${pos.size.toFixed(4)} shares`);
    }
  }

  // Size mismatches
  const sizeMatches: { local: LocalPosition; onChain: OnChainPosition }[] = [];
  const sizeMismatches: { local: LocalPosition; onChain: OnChainPosition }[] = [];

  for (const local of localPositions) {
    const onChain = onChainPositions.find(p => p.asset === local.asset);
    if (onChain) {
      if (Math.abs(local.size - onChain.size) > 0.001) {
        sizeMismatches.push({ local, onChain });
      } else {
        sizeMatches.push({ local, onChain });
      }
    }
  }

  if (sizeMismatches.length > 0) {
    console.log(`\n  [!] SIZE MISMATCHES: ${sizeMismatches.length}`);
    for (const { local, onChain } of sizeMismatches) {
      console.log(`    - ${local.title}`);
      console.log(`      Local: ${local.size.toFixed(4)} shares | On-chain: ${onChain.size.toFixed(4)} shares | Diff: ${(local.size - onChain.size).toFixed(4)}`);
    }
  }

  if (ghostPositions.length === 0 && missingFromLocal.length === 0 && sizeMismatches.length === 0) {
    console.log('\n  All positions are in sync between local state and on-chain.');
  }

  return { localPositions, onChainPositions, ghostPositions, missingFromLocal };
}

// ============================================================
// Step 2: Check tracker positions
// ============================================================

async function step2_checkTrackerPositions(
  localPositions: LocalPosition[],
  trackedWallets: WalletConfig[],
): Promise<{
  inSync: LocalPosition[];
  orphaned: LocalPosition[];
  traderPositionCounts: Map<string, number>;
}> {
  divider('STEP 2: Tracker Position Comparison');

  const enabledWallets = trackedWallets.filter(w => w.enabled);
  console.log(`\n  Tracked wallets: ${enabledWallets.length}`);

  // Fetch all trader positions
  const traderAssets = new Map<string, Set<string>>(); // alias -> set of assets
  const traderPositionCounts = new Map<string, number>();

  for (const wallet of enabledWallets) {
    console.log(`\n  Fetching positions for ${wallet.alias} (${wallet.address.slice(0, 10)}...)...`);
    try {
      const positions = await fetchPositions(wallet.address);
      const assets = new Set(positions.map(p => p.asset));
      traderAssets.set(wallet.alias, assets);
      traderPositionCounts.set(wallet.alias, positions.length);
      console.log(`    ${positions.length} active position(s)`);
    } catch (err: any) {
      console.error(`    Failed: ${err.message}`);
      traderAssets.set(wallet.alias, new Set());
      traderPositionCounts.set(wallet.alias, 0);
    }
  }

  // Compare our positions with tracker positions
  const inSync: LocalPosition[] = [];
  const orphaned: LocalPosition[] = [];

  console.log('\n  Comparing our positions with tracked traders...\n');

  for (const pos of localPositions) {
    let anyTraderHolds = false;
    let holdingTrader = '';

    for (const [alias, assets] of traderAssets.entries()) {
      if (assets.has(pos.asset)) {
        anyTraderHolds = true;
        holdingTrader = alias;
        break;
      }
    }

    if (anyTraderHolds) {
      inSync.push(pos);
      console.log(`    [OK] ${pos.title} (${pos.outcome})`);
      console.log(`          Tracker "${holdingTrader}" still holds this position`);
    } else {
      orphaned.push(pos);
      console.log(`    [!!] ${pos.title} (${pos.outcome})`);
      console.log(`          ORPHANED - No tracked trader holds this position`);
      if (pos.walletAlias) {
        console.log(`          Originally copied from: ${pos.walletAlias}`);
      }
    }
  }

  console.log(`\n  Summary: ${inSync.length} in-sync, ${orphaned.length} orphaned`);

  return { inSync, orphaned, traderPositionCounts };
}

// ============================================================
// Step 3: Test reconciliation logic (dry run)
// ============================================================

async function step3_testReconciliation(
  trackedWallets: WalletConfig[],
): Promise<{ checkedPositions: number; orphanedPositions: number }> {
  divider('STEP 3: Reconciliation (DRY RUN)');

  const stateManager = new StateManager();

  const reconciler = new PositionReconciler({
    stateManager,
    trader: null, // No trader needed for dry run
    trackedWallets,
    dryRun: true,
  });

  console.log('\n  Running reconciler in DRY RUN mode...\n');

  const result = await reconciler.reconcile();

  console.log(`\n  Reconciliation results:`);
  console.log(`    Positions checked: ${result.checkedPositions}`);
  console.log(`    Orphaned found: ${result.orphanedPositions}`);
  console.log(`    Would sell: ${result.orphanedPositions} position(s)`);
  console.log(`    Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('\n  Errors:');
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
  }

  return {
    checkedPositions: result.checkedPositions,
    orphanedPositions: result.orphanedPositions,
  };
}

// ============================================================
// Step 4: Check for stale orders
// ============================================================

async function step4_checkStaleOrders(
  localPositions: LocalPosition[],
): Promise<{ openOrders: any[]; staleOrders: any[] }> {
  divider('STEP 4: Stale Order Check');

  // Read local orders from state
  let localOrders: any[] = [];
  if (existsSync(STATE_PATH)) {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    localOrders = state.orders || [];
  }

  const pendingLocalOrders = localOrders.filter(
    (o: any) => o.status === 'pending' || o.status === 'processing'
  );
  console.log(`\n  Local orders in state.json: ${localOrders.length} total, ${pendingLocalOrders.length} pending/processing`);

  // Try to fetch open orders from the exchange
  let openOrders: any[] = [];
  let staleOrders: any[] = [];

  if (PRIVATE_KEY) {
    console.log('\n  Attempting to fetch open orders from exchange...');
    try {
      const trader = new Trader({
        privateKey: PRIVATE_KEY,
        funderAddress: FUNDER_ADDRESS || undefined,
        dryRun: true, // Safe mode
      });
      await trader.initialize();
      openOrders = await trader.getOpenOrders();
      console.log(`  Open orders on exchange: ${openOrders.length}`);

      if (openOrders.length > 0) {
        const localAssets = new Set(localPositions.map(p => p.asset));

        for (const order of openOrders) {
          const tokenId = order.asset_id || order.tokenID || order.token_id || '';
          const isStale = !localAssets.has(tokenId);

          if (isStale) {
            staleOrders.push(order);
          }

          const status = isStale ? 'STALE' : 'OK';
          const side = order.side || '?';
          const price = order.price || '?';
          const size = order.original_size || order.size || '?';

          console.log(`    [${status}] ${side} ${size} @ $${price} | Token: ${truncateAsset(tokenId)}`);
        }

        if (staleOrders.length > 0) {
          console.log(`\n  [!] ${staleOrders.length} STALE order(s) found (referencing assets we no longer hold)`);
          console.log(`      These orders should be cancelled.`);
        } else {
          console.log(`\n  All open orders reference active positions.`);
        }
      } else {
        console.log('  No open orders on exchange.');
      }
    } catch (err: any) {
      console.error(`  Failed to fetch open orders: ${err.message}`);
      console.log('  Falling back to local order state only...');
    }
  } else {
    console.log('\n  [!] PRIVATE_KEY not set - cannot fetch open orders from exchange.');
    console.log('  Checking local order state only...');
  }

  // Check local pending orders for staleness
  if (pendingLocalOrders.length > 0) {
    const localAssets = new Set(localPositions.map(p => p.asset));
    const stalePending = pendingLocalOrders.filter((o: any) => !localAssets.has(o.asset));

    if (stalePending.length > 0) {
      console.log(`\n  [!] ${stalePending.length} stale pending local order(s):`);
      for (const order of stalePending) {
        const age = Date.now() - order.createdAt;
        const ageMin = (age / (1000 * 60)).toFixed(1);
        console.log(`    - ${order.side} ${order.amount} | Asset: ${truncateAsset(order.asset)} | Age: ${ageMin}m | Status: ${order.status}`);
      }
    }
  }

  return { openOrders, staleOrders };
}

// ============================================================
// Step 5: Summary
// ============================================================

function step5_summary(data: {
  localPositions: LocalPosition[];
  onChainPositions: OnChainPosition[];
  ghostPositions: LocalPosition[];
  missingFromLocal: OnChainPosition[];
  inSync: LocalPosition[];
  orphaned: LocalPosition[];
  traderPositionCounts: Map<string, number>;
  reconcilerOrphaned: number;
  openOrders: any[];
  staleOrders: any[];
}): void {
  divider('STEP 5: Summary');

  const {
    localPositions,
    onChainPositions,
    ghostPositions,
    missingFromLocal,
    inSync,
    orphaned,
    traderPositionCounts,
    reconcilerOrphaned,
    openOrders,
    staleOrders,
  } = data;

  console.log('');
  console.log('  POSITION STATUS');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Local positions (state.json):   ${localPositions.length}`);
  console.log(`  On-chain positions (API):        ${onChainPositions.length}`);
  console.log('');
  console.log(`  In sync (tracker holds, we hold):    ${inSync.length}`);
  console.log(`  Orphaned (tracker sold, we hold):    ${orphaned.length}`);
  console.log(`  Ghost (in state.json, not on-chain): ${ghostPositions.length}`);
  console.log(`  Missing (on-chain, not in state):    ${missingFromLocal.length}`);

  console.log('');
  console.log('  TRACKED TRADERS');
  console.log('  ' + '-'.repeat(50));
  for (const [alias, count] of traderPositionCounts.entries()) {
    console.log(`  ${alias}: ${count} active position(s)`);
  }

  console.log('');
  console.log('  ORDERS');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Open orders on exchange: ${openOrders.length}`);
  console.log(`  Stale orders:            ${staleOrders.length}`);

  console.log('');
  console.log('  RECONCILER RESULT (DRY RUN)');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Would sell: ${reconcilerOrphaned} orphaned position(s)`);

  // Provide actionable recommendations
  const issues: string[] = [];
  if (orphaned.length > 0) {
    issues.push(`${orphaned.length} orphaned position(s) should be sold (run reconciler in live mode)`);
  }
  if (ghostPositions.length > 0) {
    issues.push(`${ghostPositions.length} ghost position(s) should be removed from state.json`);
  }
  if (missingFromLocal.length > 0) {
    issues.push(`${missingFromLocal.length} on-chain position(s) are not tracked in state.json`);
  }
  if (staleOrders.length > 0) {
    issues.push(`${staleOrders.length} stale order(s) should be cancelled`);
  }

  if (issues.length > 0) {
    console.log('');
    console.log('  RECOMMENDED ACTIONS');
    console.log('  ' + '-'.repeat(50));
    for (let i = 0; i < issues.length; i++) {
      console.log(`  ${i + 1}. ${issues[i]}`);
    }
  } else {
    console.log('');
    console.log('  All clear - no issues detected.');
  }

  // Detail orphaned positions with estimated value
  if (orphaned.length > 0) {
    console.log('');
    console.log('  ORPHANED POSITIONS (details)');
    console.log('  ' + '-'.repeat(50));
    let totalOrphanedValue = 0;
    for (const pos of orphaned) {
      const estValue = pos.size * pos.avgPrice;
      totalOrphanedValue += estValue;
      console.log(`  - ${pos.title} (${pos.outcome})`);
      console.log(`    ${pos.size.toFixed(4)} shares | Entry: $${pos.avgPrice.toFixed(3)} | Est. value: $${estValue.toFixed(2)}`);
      console.log(`    Copied from: ${pos.walletAlias || 'unknown'} | Held since: ${new Date(pos.entryTime).toLocaleString()}`);
    }
    console.log(`\n  Total orphaned value (at entry price): $${totalOrphanedValue.toFixed(2)}`);
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('  Reconciliation test complete.');
  console.log('='.repeat(70));
  console.log('');
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  POLYMARKET POSITION RECONCILIATION TEST');
  console.log('  ' + new Date().toLocaleString());
  console.log('='.repeat(70));

  if (!FUNDER_ADDRESS) {
    console.log('\n  WARNING: FUNDER_ADDRESS env var is not set.');
    console.log('  On-chain position checks will be skipped.\n');
  }

  const config = loadConfig();
  const trackedWallets: WalletConfig[] = config.wallets;

  console.log(`\n  Our wallet: ${FUNDER_ADDRESS || '(not set)'}`);
  console.log(`  Tracked wallets: ${trackedWallets.filter(w => w.enabled).length} enabled`);
  for (const w of trackedWallets) {
    console.log(`    - ${w.alias} (${w.address.slice(0, 10)}...) ${w.enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  // Step 1: Show current state
  const { localPositions, onChainPositions, ghostPositions, missingFromLocal } =
    await step1_showCurrentState();

  // Step 2: Check tracker positions
  const { inSync, orphaned, traderPositionCounts } =
    await step2_checkTrackerPositions(localPositions, trackedWallets);

  // Step 3: Test reconciliation logic
  const { orphanedPositions: reconcilerOrphaned } =
    await step3_testReconciliation(trackedWallets);

  // Step 4: Check for stale orders
  const { openOrders, staleOrders } =
    await step4_checkStaleOrders(localPositions);

  // Step 5: Summary
  step5_summary({
    localPositions,
    onChainPositions,
    ghostPositions,
    missingFromLocal,
    inSync,
    orphaned,
    traderPositionCounts,
    reconcilerOrphaned,
    openOrders,
    staleOrders,
  });
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
