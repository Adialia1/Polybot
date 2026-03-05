import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 2;

// Token from the Russia-Ukraine Ceasefire market
const TOKEN_ID = '8501497159083948713316135768103773293754490207922884688769443031624417212426';
const REMAINING_SHARES = 0.895713; // 1.785713 - 0.89

async function sellDirect() {
  const privateKey = process.env.PRIVATE_KEY!;
  const funderAddress = process.env.FUNDER_ADDRESS!;

  console.log('Selling remaining shares directly...');
  console.log('Token:', TOKEN_ID.slice(0, 30) + '...');
  console.log('Shares:', REMAINING_SHARES);

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

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

  // Get orderbook
  const book = await client.getOrderBook(TOKEN_ID);
  const bestBid = parseFloat(book.bids?.[0]?.price || '0.5');
  console.log('Best Bid:', bestBid);

  const sellPrice = Math.max(0.01, bestBid);

  try {
    const result = await client.createAndPostOrder(
      {
        tokenID: TOKEN_ID,
        size: REMAINING_SHARES,
        side: Side.SELL,
        price: sellPrice,
      },
      undefined,
      OrderType.GTC,
    );

    console.log('\n✅ Sell order submitted!');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.log('\n❌ Sell failed:', error?.message || error);
  }
}

sellDirect().catch(console.error);
