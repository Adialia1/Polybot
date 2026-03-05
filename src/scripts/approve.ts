import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function approve() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('No PRIVATE_KEY set in .env');
    process.exit(1);
  }

  console.log('='.repeat(50));
  console.log('  Approve USDC for Polymarket Trading');
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
  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    undefined,
    undefined,
    account.address,
  );

  console.log('');
  console.log('Setting up allowances for trading...');
  console.log('This will approve USDC spending for the Polymarket exchange.');
  console.log('');

  try {
    // The ClobClient should have methods to set up allowances
    // Let's check what's available
    const result = await client.setAllowances();
    console.log('✅ Allowances set successfully!');
    console.log('Result:', result);
  } catch (error: any) {
    console.log('');

    if (error?.message) {
      console.log('Error:', error.message);
    }

    // Try alternative approach - direct contract approval
    console.log('');
    console.log('Trying alternative approval method...');

    try {
      // Get the CTF exchange address and approve USDC
      const allowanceResult = await client.updateBalanceAllowance(1000000); // $1M allowance
      console.log('✅ Balance allowance updated!');
      console.log('Result:', allowanceResult);
    } catch (e: any) {
      console.log('Alternative also failed:', e?.message || e);
      console.log('');
      console.log('You may need to manually approve USDC on Polymarket:');
      console.log('1. Go to https://polymarket.com');
      console.log('2. Connect your wallet');
      console.log('3. Try to place a small trade');
      console.log('4. Approve the transaction when prompted');
    }
  }
}

approve().catch(console.error);
