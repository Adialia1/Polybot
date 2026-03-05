import { createPublicClient, http, formatUnits } from 'viem';
import { polygon } from 'viem/chains';

// USDC.e on Polygon (6 decimals)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;

// ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export class OnchainClient {
  private client;

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl || 'https://polygon.drpc.org'),
    });
  }

  async getUsdcBalance(walletAddress: string): Promise<number> {
    try {
      const balance = await this.client.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAddress as `0x${string}`],
      });

      // USDC has 6 decimals
      return parseFloat(formatUnits(balance, 6));
    } catch (error) {
      console.error('[Onchain] Failed to fetch USDC balance:', error);
      return 0;
    }
  }

  async getMaticBalance(walletAddress: string): Promise<number> {
    try {
      const balance = await this.client.getBalance({
        address: walletAddress as `0x${string}`,
      });

      // MATIC has 18 decimals
      return parseFloat(formatUnits(balance, 18));
    } catch (error) {
      console.error('[Onchain] Failed to fetch MATIC balance:', error);
      return 0;
    }
  }
}
