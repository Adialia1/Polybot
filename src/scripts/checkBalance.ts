import { createPublicClient, http, formatUnits } from 'viem';
import { polygon } from 'viem/chains';

const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Bridged USDC.e
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC
const USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'; // USDT on Polygon
const WALLET = '0x3C2E0048C4118add9A6357Edc95302E488F9f07d';

const ERC20_ABI = [{
  name: 'balanceOf',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ type: 'uint256' }]
}];

async function main() {
  const client = createPublicClient({
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  console.log('Checking wallet:', WALLET);
  console.log('');

  const usdceBalance = await client.readContract({
    address: USDC_E_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  });
  console.log('USDC.e (bridged):', formatUnits(usdceBalance as bigint, 6), 'USDC');

  const usdcBalance = await client.readContract({
    address: USDC_NATIVE_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  });
  console.log('USDC (native):   ', formatUnits(usdcBalance as bigint, 6), 'USDC');

  const usdtBalance = await client.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  });
  console.log('USDT:            ', formatUnits(usdtBalance as bigint, 6), 'USDT');

  // Also check native MATIC for gas
  const maticBalance = await client.getBalance({ address: WALLET });
  console.log('MATIC (gas):     ', formatUnits(maticBalance, 18), 'MATIC');
}

main().catch(console.error);
