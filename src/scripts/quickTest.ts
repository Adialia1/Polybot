import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 2; // GNOSIS_SAFE for browser wallet users

async function quickTest() {
  const privateKey = process.env.PRIVATE_KEY;
  const funderAddress = process.env.FUNDER_ADDRESS;

  if (!privateKey) {
    console.error('No PRIVATE_KEY set in .env');
    process.exit(1);
  }
  if (!funderAddress) {
    console.error('No FUNDER_ADDRESS set in .env');
    process.exit(1);
  }

  console.log('='.repeat(50));
  console.log('  Quick Trade Test ($1)');
  console.log('='.repeat(50));
  console.log('');

  // Create wallet
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log('Signer Wallet:', account.address);
  console.log('Funder (Proxy):', funderAddress);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  // Create CLOB client with signature type 2 (GNOSIS_SAFE)
  console.log('Connecting to Polymarket...');
  let client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    undefined,
    SIGNATURE_TYPE,
    funderAddress,
  );

  // Use API credentials from env (format: key, secret, passphrase)
  const creds = {
    key: process.env.POLY_API_KEY!,
    secret: process.env.POLY_API_SECRET!,
    passphrase: process.env.POLY_PASSPHRASE!,
  };

  if (!creds.key || !creds.secret || !creds.passphrase) {
    console.error('Missing API credentials in .env (POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE)');
    process.exit(1);
  }
  console.log('API Key:', creds.key.slice(0, 20) + '...');

  // Reinitialize with credentials
  client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    creds,
    SIGNATURE_TYPE,
    funderAddress,
  );

  // Find a good market to test
  console.log('');
  console.log('Finding a market to test...');

  const res = await fetch('https://gamma-api.polymarket.com/markets?closed=false&active=true&_limit=20&liquidity_min=10000');
  const markets = await res.json();

  // Find a market with reasonable odds (20-80%)
  let testMarket: any = null;
  let testTokenId: string = '';
  let testPrice: number = 0;
  let testOutcome: string = '';

  for (const market of markets) {
    if (!market.clobTokenIds || !market.outcomePrices) continue;

    try {
      const prices = JSON.parse(market.outcomePrices);
      const tokenIds = JSON.parse(market.clobTokenIds);
      const outcomes = JSON.parse(market.outcomes || '["Yes", "No"]');

      // Look for an outcome with price between 0.2 and 0.8
      for (let i = 0; i < prices.length; i++) {
        const price = parseFloat(prices[i]);
        if (price >= 0.2 && price <= 0.8) {
          testMarket = market;
          testTokenId = tokenIds[i];
          testPrice = price;
          testOutcome = outcomes[i];
          break;
        }
      }
      if (testMarket) break;
    } catch {
      continue;
    }
  }

  if (!testMarket) {
    console.log('Could not find a suitable market to test');
    process.exit(1);
  }

  console.log('');
  console.log('Market:', testMarket.question);
  console.log('Outcome:', testOutcome);
  console.log('Price:', `$${testPrice.toFixed(2)} (${(testPrice * 100).toFixed(0)}% probability)`);
  console.log('Token:', testTokenId.slice(0, 30) + '...');

  // Check orderbook
  console.log('');
  console.log('Checking orderbook...');
  try {
    const book = await client.getOrderBook(testTokenId);
    const bestBid = book.bids?.[0]?.price || 'N/A';
    const bestAsk = book.asks?.[0]?.price || 'N/A';
    console.log(`Best Bid: $${bestBid} | Best Ask: $${bestAsk}`);
  } catch {
    console.log('Could not fetch orderbook');
  }

  // Place $1 test order
  const amount = 1;
  console.log('');
  console.log(`Placing $${amount} BUY order...`);

  try {
    const result = await client.createAndPostMarketOrder(
      {
        tokenID: testTokenId,
        amount,
        side: Side.BUY,
        feeRateBps: 0,
        nonce: 0,
        price: 0.99, // Max price (slippage protection)
      },
      undefined,
      OrderType.FOK,
    );

    console.log('');
    console.log('✅ Order submitted!');
    console.log('Result:', JSON.stringify(result, null, 2));

    // Check positions
    console.log('');
    console.log('Checking your positions...');
    const positions = await fetch(`https://data-api.polymarket.com/positions?user=${account.address.toLowerCase()}`);
    const posData = await positions.json();
    console.log('Positions:', posData.length > 0 ? JSON.stringify(posData.slice(0, 3), null, 2) : 'None yet (may take a moment to update)');

  } catch (error: any) {
    console.log('');
    console.log('❌ Order failed:', error?.message || error);

    if (error?.message?.includes('allowance') || error?.message?.includes('Allowance')) {
      console.log('');
      console.log('You need to approve USDC spending first.');
      console.log('Please go to https://polymarket.com, connect your wallet,');
      console.log('and try to place a small trade to trigger the approval.');
    }

    if (error?.message?.includes('insufficient') || error?.message?.includes('balance')) {
      console.log('');
      console.log('Insufficient balance. Check your USDC.e on Polygon.');
    }
  }
}

quickTest().catch(console.error);
