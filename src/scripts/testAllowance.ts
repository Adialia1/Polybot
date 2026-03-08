import { ClobClient, AssetType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import dotenv from 'dotenv';
dotenv.config();

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: polygon, transport: http('https://polygon.drpc.org') });
const client = new ClobClient(
  'https://clob.polymarket.com', 137, walletClient,
  { key: process.env.POLY_API_KEY || '', secret: process.env.POLY_API_SECRET || '', passphrase: process.env.POLY_PASSPHRASE || '' },
  2, process.env.FUNDER_ADDRESS || ''
);

// Villarreal position token
const tokenId = '98145653976058713227940874080093749183455063167783779754187932855098772984551';

async function test() {
  console.log('1. Updating allowance with token_id...');
  await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId } as any);
  console.log('   Done');

  console.log('2. Creating GTC SELL order: 3.44 shares @ $0.99...');
  const tickSize = await client.getTickSize(tokenId);
  const negRisk = await client.getNegRisk(tokenId);
  console.log('   tickSize:', tickSize, 'negRisk:', negRisk);

  const order = await client.createOrder({
    tokenID: tokenId,
    side: 'SELL' as any,
    price: 0.99,
    size: 3.44,
    feeRateBps: undefined as any,
  }, { tickSize, negRisk });
  console.log('   Order created');

  const result = await client.postOrder(order, 'GTC' as any);
  console.log('   Result:', JSON.stringify(result));
}

test().catch(e => console.error('FAILED:', e?.response?.data || e?.message || e));
