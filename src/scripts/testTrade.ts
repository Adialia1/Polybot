import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function testTrade() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('No PRIVATE_KEY set in .env');
    process.exit(1);
  }

  // Get args: npm run test-trade <market-slug> <side> <amount>
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: npm run test-trade <token-id> <BUY|SELL> <amount-usd>');
    console.log('');
    console.log('Example: npm run test-trade 12345... BUY 1');
    console.log('');
    console.log('To find a token ID:');
    console.log('1. Go to any Polymarket market');
    console.log('2. Open browser DevTools > Network tab');
    console.log('3. Look for requests to clob.polymarket.com');
    console.log('4. The token_id is in the market data');
    console.log('');
    console.log('Or use: npm run find-market <search-term>');
    process.exit(1);
  }

  const [tokenId, sideStr, amountStr] = args;
  const side = sideStr.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
  const amount = parseFloat(amountStr);

  console.log('='.repeat(50));
  console.log('  Test Trade');
  console.log('='.repeat(50));
  console.log('');

  // Create wallet
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log('Wallet:', account.address);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  // Create CLOB client
  console.log('Connecting to Polymarket...');
  let client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    undefined,
    undefined,
    account.address,
  );

  // Derive API credentials
  console.log('Deriving API credentials...');
  const creds = await client.createOrDeriveApiKey();
  console.log('API Key:', (creds as any).apiKey.slice(0, 20) + '...');

  // Reinitialize with credentials
  client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    creds,
    undefined,
    account.address,
  );

  // Get market info
  console.log('');
  console.log('Fetching market info...');

  try {
    const book = await client.getOrderBook(tokenId);
    const bestBid = book.bids?.[0]?.price || 'N/A';
    const bestAsk = book.asks?.[0]?.price || 'N/A';
    console.log(`Best Bid: $${bestBid} | Best Ask: $${bestAsk}`);
  } catch (e) {
    console.log('Could not fetch orderbook');
  }

  // Place order
  console.log('');
  console.log(`Placing ${sideStr} order for $${amount}...`);
  console.log(`Token: ${tokenId.slice(0, 30)}...`);

  try {
    const result = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount,
        side,
        feeRateBps: 0,
        nonce: 0,
        price: side === Side.BUY ? 0.99 : 0.01, // Max slippage
      },
      undefined,
      OrderType.FOK,
    );

    console.log('');
    console.log('✅ Order submitted!');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.log('');
    console.log('❌ Order failed:', error?.message || error);

    if (error?.message?.includes('allowance')) {
      console.log('');
      console.log('You need to approve USDC spending first.');
      console.log('Run: npm run approve');
    }
  }
}

testTrade().catch(console.error);
