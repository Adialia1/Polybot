import 'dotenv/config';
import { TradeMonitor } from './services/tradeMonitor.js';
import { PositionSizer } from './services/positionSizer.js';
import { Trader } from './services/trader.js';
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
    console.log('Add wallets in src/config.ts or set TRACK_WALLETS env var');
    return;
  }

  // Initialize CLOB API for price data
  const clobApi = new ClobApiClient();

  // Initialize position sizer for smart sizing
  const positionSizer = new PositionSizer({
    userAccountSize: config.userAccountSize,
    maxPositionSize: config.maxPositionSize,
    minTradeSize: config.minTradeSize,
    maxPercentage: config.maxPercentagePerTrade,
    fixedTradePercent: (config as any).fixedTradePercent,
  });

  // Initialize trader (if trading is enabled)
  let trader: Trader | null = null;
  if (config.enableTrading) {
    if (!config.privateKey) {
      console.error('\n❌ Trading enabled but PRIVATE_KEY not set!');
      console.log('Set PRIVATE_KEY environment variable to enable trading.');
      return;
    }

    // Load API credentials from env if available
    const apiCredentials = process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE
      ? {
          key: process.env.POLY_API_KEY,
          secret: process.env.POLY_API_SECRET,
          passphrase: process.env.POLY_PASSPHRASE,
        }
      : undefined;

    trader = new Trader({
      privateKey: config.privateKey,
      funderAddress: config.funderAddress,
      dryRun: config.dryRun,
      apiCredentials,
    });

    try {
      await trader.initialize();
    } catch (err) {
      console.error('Failed to initialize trader:', err);
      return;
    }
  }

  // Initialize trade monitor
  const monitor = new TradeMonitor({
    wallets: config.wallets,
    pollingIntervalMs: config.pollingIntervalMs,
  });

  // Handle new trades detected
  monitor.on('trade', async (signal: TradeSignal, wallet: WalletConfig) => {
    const trade = signal.trade;
    const tradePrice = parseFloat(String(trade.price));

    // Filter by probability (price = probability on Polymarket)
    if (tradePrice < config.minProbability) {
      console.log(`[Filter] Skipped ${wallet.alias}'s trade: ${trade.outcome} @ $${trade.price} (${(tradePrice * 100).toFixed(1)}% < ${config.minProbability * 100}% min)`);
      return;
    }
    if (tradePrice > config.maxProbability) {
      console.log(`[Filter] Skipped ${wallet.alias}'s trade: ${trade.outcome} @ $${trade.price} (${(tradePrice * 100).toFixed(1)}% > ${config.maxProbability * 100}% max)`);
      return;
    }

    console.log('\n' + '='.repeat(50));
    console.log(`🚨 NEW TRADE SIGNAL from ${wallet.alias}`);
    console.log('='.repeat(50));

    const tradeTime = new Date(trade.timestamp * 1000);
    const delay = Date.now() - tradeTime.getTime();

    console.log(`Time: ${tradeTime.toLocaleTimeString()} (${(delay / 1000).toFixed(1)}s ago)`);
    console.log(`Market: ${trade.title}`);
    console.log(`Outcome: ${trade.outcome}`);
    console.log(`Side: ${trade.side}`);
    console.log(`Size: ${trade.size} shares`);
    console.log(`Price: $${trade.price} (${(tradePrice * 100).toFixed(1)}% probability)`);

    // Calculate position size
    let finalSize = 0;
    try {
      const sizing = await positionSizer.calculatePositionSize(trade, wallet.address);

      console.log(`\n📊 Position Sizing:`);
      console.log(`  Trader's trade: $${sizing.originalTradeValue.toFixed(2)}`);
      console.log(`  Trader's account: $${sizing.traderAccountSize.toFixed(2)}`);
      console.log(`  Trade %: ${sizing.tradePercentage.toFixed(3)}% of their account`);
      console.log(`  ─────────────────────`);
      console.log(`  Your account: $${sizing.yourAccountSize.toFixed(2)}`);
      console.log(`  Proportional: $${sizing.recommendedSize.toFixed(2)}`);
      console.log(`  Final size: $${sizing.cappedSize.toFixed(2)} (${sizing.reason})`);

      finalSize = sizing.cappedSize;

      if (sizing.cappedSize === 0) {
        console.log(`\n⏭️  Skipping trade (${sizing.reason})`);
        console.log('='.repeat(50) + '\n');
        return;
      }
    } catch (err: any) {
      console.log(`\n  [Could not calculate position size - skipping]`);
      console.log(`  Error: ${err?.message || err}`);
      console.log('='.repeat(50) + '\n');
      return;
    }

    // Get current market price
    try {
      const spread = await clobApi.getSpread(trade.asset);

      console.log(`\n💹 Current Market:`);
      console.log(`  Bid: $${spread.bid} | Ask: $${spread.ask} | Spread: $${spread.spread}`);

      // Calculate potential slippage
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

    // Execute trade if trading is enabled
    if (trader && config.enableTrading && finalSize > 0) {
      console.log(`\n🔄 Executing trade...`);

      // Add delay if configured
      if (config.copyDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, config.copyDelayMs));
      }

      const result = await trader.copyTrade(trade, finalSize);

      if (result.success) {
        console.log(`\n✅ Trade ${config.dryRun ? 'SIMULATED' : 'EXECUTED'} successfully!`);
        if (result.orderId) {
          console.log(`  Order ID: ${result.orderId}`);
        }
        if (result.details) {
          console.log(`  ${result.details.side} $${finalSize.toFixed(2)} @ $${result.details.price.toFixed(4)}`);
        }
      } else {
        console.log(`\n❌ Trade failed: ${result.error}`);
      }
    } else if (!config.enableTrading) {
      console.log('\n📋 Trade ready to copy (trading disabled)');
    }

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
  console.log(`Your account: $${config.userAccountSize} | Max per trade: $${config.maxPositionSize}`);
  console.log(`Probability filter: ${config.minProbability * 100}% - ${config.maxProbability * 100}%`);

  if (config.enableTrading) {
    console.log(`Trading: ${config.dryRun ? '🔶 DRY RUN (simulated)' : '🟢 LIVE'}`);
  } else {
    console.log(`Trading: ⚪ DISABLED (monitor only)`);
  }

  console.log(`Polling: every ${config.pollingIntervalMs / 1000}s`);
  console.log('\nWaiting for new trades... (Ctrl+C to stop)\n');
}

// CLI commands for testing
const args = process.argv.slice(2);

if (args[0] === 'check-balance') {
  const { OnchainClient } = await import('./api/onchain.js');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createPublicClient, http, formatUnits } = await import('viem');
  const { polygon } = await import('viem/chains');
  const onchain = new OnchainClient();
  const config = loadConfig();

  let walletAddress: string;
  if (config.privateKey) {
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    walletAddress = account.address;
  } else {
    console.error('No PRIVATE_KEY configured');
    process.exit(1);
  }

  console.log('Checking wallet:', walletAddress);
  console.log('');

  const client = createPublicClient({
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  const ERC20_ABI = [{
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }];

  // Check all relevant tokens
  const tokens = [
    { name: 'USDC.e (bridged)', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
    { name: 'USDC (native)', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    { name: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  ];

  let totalStable = 0;
  for (const token of tokens) {
    const balance = await client.readContract({
      address: token.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    });
    const formatted = parseFloat(formatUnits(balance as bigint, token.decimals));
    totalStable += formatted;
    console.log(`${token.name}: $${formatted.toFixed(2)}`);
  }

  // MATIC for gas
  const maticBalance = await client.getBalance({ address: walletAddress as `0x${string}` });
  const maticFormatted = parseFloat(formatUnits(maticBalance, 18));
  console.log(`MATIC (gas): ${maticFormatted.toFixed(4)} MATIC`);

  console.log('');
  if (totalStable > 0) {
    console.log(`✅ Wallet has $${totalStable.toFixed(2)} in stablecoins`);
    if (maticFormatted < 0.01) {
      console.log('⚠️  Low MATIC - you may need gas for transactions');
    }
  } else {
    console.log('⚠️  Wallet has no stablecoins - please fund it on Polygon');
    console.log('\nNote: Bridge transactions can take 10-30 minutes to complete.');
    console.log('Check your transaction at: https://polygonscan.com/address/' + walletAddress);
  }
} else if (args[0] === 'positions' && args[1]) {
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
