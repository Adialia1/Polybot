/**
 * Live position monitor - shows real-time P&L % for all positions.
 * Run: npx tsx src/scripts/monitorPositions.ts
 *
 * Refreshes every 10 seconds and shows:
 * - Current price vs entry price
 * - P&L % for each position
 * - Trailing stop status (highest price, drop from peak)
 * - Whether the tracked trader still holds the position
 */

import 'dotenv/config';
import { ClobApiClient } from '../api/clobApi.js';
import { loadConfig } from '../config.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_PATH = join(process.cwd(), 'data', 'state.json');
const REFRESH_INTERVAL = parseInt(process.argv[2] || '10') * 1000; // Default 10s

interface StatePosition {
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

function loadPositions(): StatePosition[] {
  if (!existsSync(STATE_PATH)) return [];
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  return Object.values(state.positions || {});
}

async function fetchTraderPositions(walletAddress: string): Promise<Set<string>> {
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${walletAddress.toLowerCase()}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      return new Set(data.map((p: any) => p.asset));
    }
  } catch (e) {
    // Ignore
  }
  return new Set();
}

async function monitor() {
  const config = loadConfig();
  const clobApi = new ClobApiClient();

  console.log('='.repeat(70));
  console.log('  Live Position Monitor');
  console.log('='.repeat(70));
  console.log(`Refresh: every ${REFRESH_INTERVAL / 1000}s | Press Ctrl+C to stop\n`);

  const trackedWallets = config.wallets.filter(w => w.enabled);

  const refresh = async () => {
    const positions = loadPositions();

    if (positions.length === 0) {
      console.clear();
      console.log('[Monitor] No open positions');
      return;
    }

    // Fetch trader positions for reconciliation check
    const traderAssets = new Map<string, Set<string>>();
    for (const wallet of trackedWallets) {
      const assets = await fetchTraderPositions(wallet.address);
      traderAssets.set(wallet.alias, assets);
    }

    // Clear screen and print header
    console.clear();
    const now = new Date().toLocaleTimeString();
    console.log(`Position Monitor | ${now} | ${positions.length} positions\n`);

    let totalValue = 0;
    let totalPnL = 0;

    const rows: string[] = [];

    for (const pos of positions) {
      try {
        const spread = await clobApi.getSpread(pos.asset);
        const bidPrice = parseFloat(spread.bid || '0');
        const askPrice = parseFloat(spread.ask || '0');
        const midPrice = (bidPrice + askPrice) / 2;

        // P&L calculation
        const pnlPercent = pos.avgPrice > 0
          ? ((midPrice - pos.avgPrice) / pos.avgPrice) * 100
          : 0;
        const pnlUsd = (midPrice - pos.avgPrice) * pos.size;
        const posValue = midPrice * pos.size;

        totalValue += posValue;
        totalPnL += pnlUsd;

        // Trailing stop info
        const highestPrice = pos.highestPrice || pos.avgPrice;
        const dropFromPeak = highestPrice > 0
          ? ((highestPrice - midPrice) / highestPrice) * 100
          : 0;

        // Check if trader still holds
        let traderStatus = '';
        for (const [alias, assets] of traderAssets.entries()) {
          if (pos.walletAlias === alias || !pos.walletAlias) {
            if (assets.has(pos.asset)) {
              traderStatus = `${alias}: HOLDING`;
            } else {
              traderStatus = `${alias}: SOLD`;
            }
          }
        }

        // Hold time
        const holdMs = Date.now() - pos.entryTime;
        const holdHours = (holdMs / (1000 * 60 * 60)).toFixed(1);

        // Format P&L with color indicator
        const pnlSign = pnlPercent >= 0 ? '+' : '';
        const pnlIndicator = pnlPercent >= 10 ? '[UP]' : pnlPercent <= -10 ? '[DOWN]' : '[--]';

        rows.push(
          `${pnlIndicator} ${pos.title.slice(0, 45).padEnd(45)} | ${pos.outcome.padEnd(8)}` +
          `\n    Entry: $${pos.avgPrice.toFixed(3)} | Now: $${midPrice.toFixed(3)} | P&L: ${pnlSign}${pnlPercent.toFixed(1)}% ($${pnlUsd.toFixed(2)})` +
          `\n    Size: ${pos.size.toFixed(2)} shares ($${posValue.toFixed(2)}) | Hold: ${holdHours}h | Peak: $${highestPrice.toFixed(3)} (-${dropFromPeak.toFixed(1)}%)` +
          `\n    Trader: ${traderStatus || 'unknown'} | Trailing Stop: ${config.trailingStopPercent}% (drop: ${dropFromPeak.toFixed(1)}%${dropFromPeak >= config.trailingStopPercent ? ' TRIGGER!' : ''})` +
          `\n`
        );
      } catch (err: any) {
        rows.push(
          `[??] ${pos.title.slice(0, 45)} | ${pos.outcome}` +
          `\n    Error fetching price: ${err?.message || 'unknown'}` +
          `\n`
        );
      }
    }

    // Print sorted by P&L (worst first)
    for (const row of rows) {
      console.log(row);
    }

    // Summary
    const totalPnLSign = totalPnL >= 0 ? '+' : '';
    console.log('-'.repeat(70));
    console.log(`Total Value: $${totalValue.toFixed(2)} | Total P&L: ${totalPnLSign}$${totalPnL.toFixed(2)}`);
    console.log(`Daily Loss Limit: $${config.dailyLossLimit} | Trailing Stop: ${config.trailingStopPercent}%`);
    console.log(`\nNext refresh in ${REFRESH_INTERVAL / 1000}s...`);
  };

  // Initial refresh
  await refresh();

  // Periodic refresh
  setInterval(async () => {
    try {
      await refresh();
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }, REFRESH_INTERVAL);
}

monitor().catch(console.error);
