import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 2;

async function sellPosition() {
  const privateKey = process.env.PRIVATE_KEY!;
  const funderAddress = process.env.FUNDER_ADDRESS!;

  const args = process.argv.slice(2);
  const sellPercent = args[0] ? parseFloat(args[0]) : 100; // Default: sell all

  console.log('='.repeat(50));
  console.log(`  Sell Position (${sellPercent}%)`);
  console.log('='.repeat(50));
  console.log('');

  // Create wallet
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log('Signer:', account.address);
  console.log('Funder:', funderAddress);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  // Use API credentials
  const creds = {
    key: process.env.POLY_API_KEY!,
    secret: process.env.POLY_API_SECRET!,
    passphrase: process.env.POLY_PASSPHRASE!,
  };

  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    creds,
    SIGNATURE_TYPE,
    funderAddress,
  );

  // Get current positions
  console.log('\nFetching your positions...');
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${funderAddress.toLowerCase()}`);
  const positions = await res.json();

  if (positions.length === 0) {
    console.log('No positions found.');
    return;
  }

  console.log(`\nFound ${positions.length} position(s):\n`);

  for (const pos of positions) {
    console.log(`Market: ${pos.title}`);
    console.log(`  Outcome: ${pos.outcome}`);
    console.log(`  Shares: ${pos.size}`);
    console.log(`  Current Price: $${pos.curPrice}`);
    console.log(`  Value: $${(pos.size * pos.curPrice).toFixed(2)}`);
    console.log(`  Token: ${pos.asset.slice(0, 30)}...`);

    // Calculate sell amount
    const sellSize = pos.size * (sellPercent / 100);

    console.log(`\n  Selling ${sellPercent}% = ${sellSize.toFixed(6)} shares...`);

    try {
      // Get orderbook for price reference
      const book = await client.getOrderBook(pos.asset);
      const bestBid = parseFloat(book.bids?.[0]?.price || '0');
      const bestAsk = parseFloat(book.asks?.[0]?.price || '1');
      const curPrice = pos.curPrice;

      console.log(`  Best Bid: $${bestBid.toFixed(3)} | Best Ask: $${bestAsk.toFixed(3)}`);

      // Use current price, ensuring it's within valid range (0.01 - 0.99)
      let sellPrice = Math.max(0.01, Math.min(0.99, curPrice * 0.95));
      // If best bid is reasonable, use it
      if (bestBid >= 0.01) {
        sellPrice = bestBid;
      }

      console.log(`  Sell Price: $${sellPrice.toFixed(3)}`);

      // Place sell order
      const result = await client.createAndPostOrder(
        {
          tokenID: pos.asset,
          size: sellSize,
          side: Side.SELL,
          price: sellPrice,
        },
        undefined,
        OrderType.GTC,
      );

      console.log('\n  ✅ Sell order submitted!');
      console.log('  Result:', JSON.stringify(result, null, 2));
    } catch (error: any) {
      console.log('\n  ❌ Sell failed:', error?.message || error);
    }

    console.log('');
  }
}

sellPosition().catch(console.error);
