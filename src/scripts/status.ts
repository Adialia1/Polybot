import 'dotenv/config';
import { StateManager, TraderStats } from '../services/stateManager.js';

const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || '';

/**
 * Format hold time in human-readable format
 */
function formatHoldTime(holdTimeMs: number): string {
  const totalMinutes = Math.floor(holdTimeMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

async function showStatus() {
  console.log('='.repeat(50));
  console.log('  Polymarket Bot Status');
  console.log('='.repeat(50));
  console.log('');

  // Load state manager to get bot stats
  const stateManager = new StateManager();

  // Get positions
  console.log('📊 Current Positions:');
  const posRes = await fetch(
    `https://data-api.polymarket.com/positions?user=${FUNDER_ADDRESS.toLowerCase()}`
  );
  const positions = await posRes.json();

  if (positions.length === 0) {
    console.log('  No open positions\n');
  } else {
    let totalValue = 0;
    for (const pos of positions) {
      const value = pos.size * pos.curPrice;
      totalValue += value;
      console.log(`  ${pos.title}`);
      console.log(`    ${pos.outcome}: ${pos.size.toFixed(4)} shares @ $${pos.curPrice.toFixed(3)}`);
      console.log(`    Value: $${value.toFixed(2)} | P&L: ${pos.percentPnl?.toFixed(1) || 0}%`);
    }
    console.log(`\n  Total Position Value: $${totalValue.toFixed(2)}\n`);
  }

  // Get recent activity
  console.log('📜 Recent Activity (last 5):');
  const actRes = await fetch(
    `https://data-api.polymarket.com/activity?user=${FUNDER_ADDRESS.toLowerCase()}&limit=5`
  );
  const activity = await actRes.json();

  if (activity.length === 0) {
    console.log('  No recent activity\n');
  } else {
    for (const act of activity) {
      const time = new Date(act.timestamp * 1000).toLocaleString();
      const side = act.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      console.log(`  ${time}`);
      console.log(`    ${side} ${act.size.toFixed(4)} ${act.outcome} @ $${act.price.toFixed(3)}`);
      console.log(`    ${act.title}`);
    }
    console.log('');
  }

  // Show per-trader performance stats
  console.log('📈 Trader Performance:');
  const traderStats = stateManager.getAllTraderStats();
  const traderAliases = Object.keys(traderStats);

  if (traderAliases.length === 0) {
    console.log('  No trader stats recorded yet\n');
  } else {
    for (const alias of traderAliases) {
      const stats: TraderStats = traderStats[alias];
      const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
      const pnlSign = stats.totalPnL >= 0 ? '+' : '';

      console.log(`  ${alias}:`);
      console.log(`    Total P&L: ${pnlSign}$${stats.totalPnL.toFixed(2)}`);
      console.log(`    Win Rate: ${winRate}% (${stats.wins}W / ${stats.losses}L / ${stats.totalTrades} total)`);
      console.log(`    Avg Hold Time: ${formatHoldTime(stats.avgHoldTimeMs)}`);
    }
    console.log('');
  }

  // Show daily P&L
  console.log('📅 Daily P&L:');
  const dailyPnL = stateManager.getDailyPnL();
  const dailyPnLDate = stateManager.getDailyPnLDate();
  const dailyPnLSign = dailyPnL >= 0 ? '+' : '';
  console.log(`  ${dailyPnLDate}: ${dailyPnLSign}$${dailyPnL.toFixed(2)}\n`);

  // Get Polymarket balance (approximate from activity)
  console.log('💰 Account Summary:');
  console.log(`  Proxy Wallet: ${FUNDER_ADDRESS}`);
  console.log(`  Positions: ${positions.length}`);
  console.log(`  Trades Today: ${activity.length}`);

  // Show bot stats
  const botStats = stateManager.getStats();
  console.log(`\n📉 Bot Stats (all time):`);
  console.log(`  Total Trades: ${botStats.totalTrades}`);
  console.log(`  Successful: ${botStats.successfulTrades}`);
  console.log(`  Failed: ${botStats.failedTrades}`);
  console.log(`  Volume: $${botStats.totalVolume.toFixed(2)}`);
  console.log(`  Running since: ${new Date(botStats.startTime).toLocaleString()}`);
}

showStatus().catch(console.error);
