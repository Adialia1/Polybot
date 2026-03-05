import 'dotenv/config';
import { TradeMonitor } from './services/tradeMonitor.js';
import { ClobApiClient } from './api/clobApi.js';
import { loadConfig } from './config.js';
import { TradeSignal, WalletConfig } from './types/index.js';

async function main() {
  console.log('='.repeat(50));
  console.log('  Polymarket Trade Copier Bot');
  console.log('='.repeat(50));

  const config = loadConfig();

  if (config.wallets.length === 0) {
    console.log('\nNo wallets configured to track.');
    console.log('Add wallets to track in one of these ways:\n');
    console.log('1. Edit src/config.ts and add wallets to the wallets array');
    console.log('2. Set TRACK_WALLETS environment variable as JSON array');
    console.log('\nExample wallet format:');
    console.log(JSON.stringify({
      address: '0x1234...abcd',
      alias: 'WhaleTrader',
      enabled: true,
    }, null, 2));
    return;
  }

  // Initialize CLOB API for price data
  const clobApi = new ClobApiClient();

  // Initialize trade monitor
  const monitor = new TradeMonitor({
    wallets: config.wallets,
    pollingIntervalMs: config.pollingIntervalMs,
  });

  // Handle new trades detected
  monitor.on('trade', async (signal: TradeSignal, wallet: WalletConfig) => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚨 NEW TRADE SIGNAL from ${wallet.alias}`);
    console.log('='.repeat(50));

    const trade = signal.trade;
    const tradeTime = new Date(trade.timestamp * 1000);
    const delay = Date.now() - tradeTime.getTime();

    console.log(`Time: ${tradeTime.toLocaleTimeString()} (${(delay / 1000).toFixed(1)}s ago)`);
    console.log(`Market: ${trade.title}`);
    console.log(`Outcome: ${trade.outcome}`);
    console.log(`Side: ${trade.side}`);
    console.log(`Size: ${trade.size} shares`);
    console.log(`Price: $${trade.price}`);

    // Get current market price
    try {
      const spread = await clobApi.getSpread(trade.asset);

      console.log(`\nCurrent Market:`);
      console.log(`  Bid: $${spread.bid} | Ask: $${spread.ask} | Spread: $${spread.spread}`);

      // Calculate potential slippage
      const tradePrice = parseFloat(String(trade.price));
      if (trade.side === 'BUY') {
        const askPrice = parseFloat(spread.ask);
        const slippage = ((askPrice - tradePrice) / tradePrice * 100).toFixed(2);
        console.log(`  Copy price: $${spread.ask} (${slippage}% slippage)`);
      } else {
        const bidPrice = parseFloat(spread.bid);
        const slippage = ((tradePrice - bidPrice) / tradePrice * 100).toFixed(2);
        console.log(`  Copy price: $${spread.bid} (${slippage}% slippage)`);
      }
    } catch (err) {
      console.log(`\n  [Could not fetch current price]`);
    }

    console.log('\n📋 Trade ready to copy');
    console.log('='.repeat(50) + '\n');
  });

  // Handle errors
  monitor.on('error', ({ wallet, error }) => {
    console.error(`[Error] ${wallet.alias}:`, error);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    monitor.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start monitoring
  console.log('\nStarting trade monitor...');
  await monitor.start();

  console.log('\n✅ Bot is running!');
  console.log(`Tracking: ${config.wallets.filter(w => w.enabled).map(w => w.alias).join(', ')}`);
  console.log(`Polling: every ${config.pollingIntervalMs / 1000}s`);
  console.log('\nWaiting for new trades... (Ctrl+C to stop)\n');
}

// CLI commands for testing
const args = process.argv.slice(2);

if (args[0] === 'positions' && args[1]) {
  const { DataApiClient } = await import('./api/dataApi.js');
  const dataApi = new DataApiClient();
  console.log(`Fetching positions for ${args[1]}...`);
  dataApi.getAllPositions(args[1]).then(positions => {
    console.log(`Found ${positions.length} positions:\n`);
    for (const pos of positions.slice(0, 20)) {
      console.log(`${pos.title}`);
      console.log(`  ${pos.outcome}: ${pos.size} @ $${pos.avgPrice} → $${pos.curPrice}`);
      console.log(`  P&L: $${pos.cashPnl} (${pos.percentPnl}%)\n`);
    }
    if (positions.length > 20) {
      console.log(`... and ${positions.length - 20} more positions`);
    }
  }).catch(console.error);
} else if (args[0] === 'trades' && args[1]) {
  const { DataApiClient } = await import('./api/dataApi.js');
  const dataApi = new DataApiClient();
  console.log(`Fetching recent trades for ${args[1]}...\n`);
  dataApi.getTrades(args[1], { limit: 10 }).then(trades => {
    for (const trade of trades) {
      const time = new Date(trade.timestamp * 1000);
      console.log(`${time.toLocaleString()}`);
      console.log(`  ${trade.side} ${trade.outcome} @ $${trade.price} (${trade.size} shares)`);
      console.log(`  ${trade.title}\n`);
    }
  }).catch(console.error);
} else {
  main().catch(console.error);
}
