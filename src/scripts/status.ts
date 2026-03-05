import 'dotenv/config';

const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || '';

async function showStatus() {
  console.log('='.repeat(50));
  console.log('  Polymarket Bot Status');
  console.log('='.repeat(50));
  console.log('');

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

  // Get Polymarket balance (approximate from activity)
  console.log('💰 Account Summary:');
  console.log(`  Proxy Wallet: ${FUNDER_ADDRESS}`);
  console.log(`  Positions: ${positions.length}`);
  console.log(`  Trades Today: ${activity.length}`);
}

showStatus().catch(console.error);
