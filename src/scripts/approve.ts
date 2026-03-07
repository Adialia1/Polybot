import 'dotenv/config';
import { createWalletClient, http, parseUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// Token addresses
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CONDITIONAL_TOKEN_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Exchange contract addresses that need approval
const EXCHANGE_CONTRACTS = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Main exchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a', // Neg risk markets
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', // Neg risk adapter
];

// ERC20 approve ABI
const APPROVE_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

async function approveAllowances() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ No PRIVATE_KEY set in .env');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  SET POLYMARKET TRADING ALLOWANCES');
  console.log('='.repeat(60));
  console.log('');

  // Create wallet
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log('Wallet:', account.address);
  console.log('');

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  // Unlimited approval amount (max uint256)
  const unlimitedAmount = parseUnits('1000000000', 6); // 1 billion USDC (with 6 decimals)

  console.log('🔄 Approving USDC for exchange contracts...');
  console.log('');

  // Approve USDC for all exchange contracts
  for (const exchangeContract of EXCHANGE_CONTRACTS) {
    try {
      console.log(`Approving ${exchangeContract}...`);

      const hash = await walletClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: APPROVE_ABI,
        functionName: 'approve',
        args: [exchangeContract as `0x${string}`, unlimitedAmount],
      });

      console.log(`  ✅ Transaction sent: ${hash}`);
      console.log(`  Waiting for confirmation...`);

      // Wait a bit for the transaction to be mined
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch (error: any) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }

  console.log('');
  console.log('🔄 Approving Conditional Tokens for exchange contracts...');
  console.log('');

  // Approve Conditional Tokens for all exchange contracts
  // Note: Conditional tokens use setApprovalForAll instead of approve
  const SET_APPROVAL_FOR_ALL_ABI = [
    {
      inputs: [
        { name: 'operator', type: 'address' },
        { name: 'approved', type: 'bool' },
      ],
      name: 'setApprovalForAll',
      outputs: [],
      stateMutability: 'nonpayable',
      type: 'function',
    },
  ] as const;

  for (const exchangeContract of EXCHANGE_CONTRACTS) {
    try {
      console.log(`Approving ${exchangeContract}...`);

      const hash = await walletClient.writeContract({
        address: CONDITIONAL_TOKEN_ADDRESS as `0x${string}`,
        abi: SET_APPROVAL_FOR_ALL_ABI,
        functionName: 'setApprovalForAll',
        args: [exchangeContract as `0x${string}`, true],
      });

      console.log(`  ✅ Transaction sent: ${hash}`);
      console.log(`  Waiting for confirmation...`);

      // Wait a bit for the transaction to be mined
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch (error: any) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('✅ ALLOWANCE SETUP COMPLETE!');
  console.log('='.repeat(60));
  console.log('');
  console.log('You can now trade on Polymarket!');
  console.log('Restart your bot to start copying trades.');
  console.log('');
}

approveAllowances()
  .catch((error) => {
    console.error('');
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
