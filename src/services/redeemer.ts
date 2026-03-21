import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { DataApiClient } from '../api/dataApi.js';
import { StateManager } from './stateManager.js';
import { errorLogger } from './errorLogger.js';

// Contract addresses (Polygon mainnet)
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as const;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

// ABI for ConditionalTokens.redeemPositions (standard markets)
const CTF_REDEEM_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

// ABI for NegRiskAdapter.redeemPositions (neg risk markets)
const NEG_RISK_REDEEM_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

// ABI for ProxyWalletFactory.proxy (for POLY_PROXY wallets)
const PROXY_WALLET_FACTORY_ABI = [
  {
    name: 'proxy',
    type: 'function',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'returnValues', type: 'bytes[]' }],
  },
] as const;

const PROXY_WALLET_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;

// Gnosis Safe execTransaction ABI
const SAFE_EXEC_ABI = [
  {
    name: 'execTransaction',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

export interface RedeemResult {
  asset: string;
  title: string;
  conditionId: string;
  success: boolean;
  txHash?: string;
  usdcRedeemed?: number;
  error?: string;
}

export interface RedeemerConfig {
  privateKey: string;
  funderAddress?: string;
  signatureType: number; // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
  rpcUrl?: string;
}

export class Redeemer {
  private dataApi: DataApiClient;
  private stateManager: StateManager;
  private config: RedeemerConfig;
  private publicClient;
  private walletClient;
  private account;
  private funderAddress: string;

  constructor(config: RedeemerConfig, stateManager: StateManager) {
    this.config = config;
    this.stateManager = stateManager;
    this.dataApi = new DataApiClient();

    const rpcUrl = config.rpcUrl || 'https://polygon.drpc.org';
    this.account = privateKeyToAccount(config.privateKey as `0x${string}`);
    this.funderAddress = config.funderAddress || this.account.address;

    this.publicClient = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: polygon,
      transport: http(rpcUrl),
    });

    console.log(`[Redeemer] Initialized — signer: ${this.account.address.slice(0, 10)}..., funder: ${this.funderAddress.slice(0, 10)}...`);
  }

  /**
   * Check all positions for redeemable ones and redeem them on-chain.
   * Returns results for each attempted redemption.
   */
  async redeemAll(): Promise<RedeemResult[]> {
    const results: RedeemResult[] = [];

    try {
      // Fetch positions from Data API to check redeemable flag
      const apiPositions = await this.dataApi.getPositions(this.funderAddress, {
        limit: 200,
        sizeThreshold: 0.01,
      });

      const redeemable = apiPositions.filter(p => p.redeemable && parseFloat(p.size) > 0.001);

      if (redeemable.length === 0) {
        console.log('[Redeemer] No redeemable positions found');
        return results;
      }

      console.log(`[Redeemer] Found ${redeemable.length} redeemable position(s)`);

      // Group by conditionId to redeem each market once
      const byCondition = new Map<string, typeof redeemable>();
      for (const pos of redeemable) {
        const existing = byCondition.get(pos.conditionId) || [];
        existing.push(pos);
        byCondition.set(pos.conditionId, existing);
      }

      for (const [conditionId, positions] of byCondition) {
        const firstPos = positions[0];
        const title = firstPos.title || 'Unknown';
        const label = `${title.slice(0, 40)} (${firstPos.outcome})`;

        try {
          console.log(`[Redeemer] Redeeming: ${label}`);

          // Determine if neg risk market by checking the CLOB client
          // For simplicity, try standard redemption first, fall back to neg risk
          const result = await this.redeemPosition(conditionId, positions);

          if (result.success) {
            console.log(`[Redeemer] ✅ Redeemed: ${label} — tx: ${result.txHash?.slice(0, 16)}...`);

            // Remove from state manager
            for (const pos of positions) {
              const localPos = this.stateManager.getPosition(pos.asset);
              if (localPos) {
                this.stateManager.updatePosition(pos.asset, -localPos.size, 1.0);
                // Record as profit (redeemed at $1 per share)
                const pnl = (1.0 - localPos.avgPrice) * localPos.size;
                this.stateManager.updateDailyPnL(pnl);
              }
            }
          } else {
            console.log(`[Redeemer] ❌ Failed: ${label} — ${result.error}`);
          }

          results.push(result);

          // Small delay between redemptions
          await new Promise(r => setTimeout(r, 2000));
        } catch (err: any) {
          errorLogger.logError('Redeemer.redeemAll', err, { conditionId, title: label });
          results.push({
            asset: firstPos.asset,
            title: label,
            conditionId,
            success: false,
            error: err?.message || 'Unknown error',
          });
        }
      }
    } catch (err: any) {
      errorLogger.logError('Redeemer.redeemAll', err);
      console.error('[Redeemer] Error checking redeemable positions:', err?.message);
    }

    return results;
  }

  /**
   * Redeem a specific market's positions on-chain.
   */
  private async redeemPosition(
    conditionId: string,
    positions: any[],
  ): Promise<RedeemResult> {
    const firstPos = positions[0];
    const title = firstPos.title || 'Unknown';

    // Encode the redemption calldata
    // Standard markets: CTF.redeemPositions(USDC, 0x0, conditionId, [1, 2])
    const redeemCalldata = encodeFunctionData({
      abi: CTF_REDEEM_ABI,
      functionName: 'redeemPositions',
      args: [
        USDC_ADDRESS,
        ZERO_BYTES32,
        conditionId as `0x${string}`,
        [BigInt(1), BigInt(2)],
      ],
    });

    try {
      let txHash: string;

      if (this.config.signatureType === 1) {
        // POLY_PROXY: Call through ProxyWalletFactory
        txHash = await this.executeViaProxyFactory(CTF_ADDRESS, redeemCalldata);
      } else if (this.config.signatureType === 2) {
        // GNOSIS_SAFE: Call through Safe execTransaction
        txHash = await this.executeViaSafe(CTF_ADDRESS, redeemCalldata);
      } else {
        // EOA: Direct call
        txHash = await this.executeDirect(CTF_ADDRESS, redeemCalldata);
      }

      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: 30000,
      });

      if (receipt.status === 'success') {
        return {
          asset: firstPos.asset,
          title,
          conditionId,
          success: true,
          txHash,
        };
      } else {
        // Standard redemption failed — try neg risk adapter
        console.log(`[Redeemer] Standard redeem failed, trying NegRiskAdapter...`);
        return await this.redeemNegRisk(conditionId, positions);
      }
    } catch (err: any) {
      // If standard call reverted, try neg risk
      if (err?.message?.includes('revert') || err?.message?.includes('execution reverted')) {
        console.log(`[Redeemer] Standard redeem reverted, trying NegRiskAdapter...`);
        return await this.redeemNegRisk(conditionId, positions);
      }

      return {
        asset: firstPos.asset,
        title,
        conditionId,
        success: false,
        error: err?.message || 'Transaction failed',
      };
    }
  }

  /**
   * Redeem via NegRiskAdapter for neg-risk markets.
   */
  private async redeemNegRisk(
    conditionId: string,
    positions: any[],
  ): Promise<RedeemResult> {
    const firstPos = positions[0];
    const title = firstPos.title || 'Unknown';

    // For neg risk: amounts array with token amounts (in 6 decimal USDC units)
    const amounts = positions.map(p => {
      const size = parseFloat(p.size);
      return parseUnits(size.toFixed(6), 6);
    });

    const redeemCalldata = encodeFunctionData({
      abi: NEG_RISK_REDEEM_ABI,
      functionName: 'redeemPositions',
      args: [
        conditionId as `0x${string}`,
        amounts,
      ],
    });

    try {
      let txHash: string;

      if (this.config.signatureType === 1) {
        txHash = await this.executeViaProxyFactory(NEG_RISK_ADAPTER, redeemCalldata);
      } else if (this.config.signatureType === 2) {
        txHash = await this.executeViaSafe(NEG_RISK_ADAPTER, redeemCalldata);
      } else {
        txHash = await this.executeDirect(NEG_RISK_ADAPTER, redeemCalldata);
      }

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: 30000,
      });

      return {
        asset: firstPos.asset,
        title,
        conditionId,
        success: receipt.status === 'success',
        txHash,
        error: receipt.status !== 'success' ? 'Transaction reverted' : undefined,
      };
    } catch (err: any) {
      return {
        asset: firstPos.asset,
        title,
        conditionId,
        success: false,
        error: err?.message || 'NegRisk redemption failed',
      };
    }
  }

  /**
   * Execute a contract call directly (EOA mode).
   */
  private async executeDirect(to: string, data: string): Promise<string> {
    const txHash = await this.walletClient.sendTransaction({
      to: to as `0x${string}`,
      data: data as `0x${string}`,
      value: BigInt(0),
    });
    return txHash;
  }

  /**
   * Execute a contract call through the ProxyWalletFactory (POLY_PROXY mode).
   */
  private async executeViaProxyFactory(to: string, data: string): Promise<string> {
    const proxyCalldata = encodeFunctionData({
      abi: PROXY_WALLET_FACTORY_ABI,
      functionName: 'proxy',
      args: [[{ to: to as `0x${string}`, value: BigInt(0), data: data as `0x${string}` }]],
    });

    const txHash = await this.walletClient.sendTransaction({
      to: PROXY_WALLET_FACTORY,
      data: proxyCalldata as `0x${string}`,
      value: BigInt(0),
    });
    return txHash;
  }

  /**
   * Execute a contract call through a Gnosis Safe (GNOSIS_SAFE mode).
   * Uses pre-validated signature (owner sends tx directly to Safe).
   */
  private async executeViaSafe(to: string, data: string): Promise<string> {
    // Pre-validated signature: owner address padded + signature type byte (01)
    const ownerPadded = this.account.address.toLowerCase().replace('0x', '').padStart(64, '0');
    const preValidatedSig = `0x000000000000000000000000${ownerPadded}000000000000000000000000000000000000000000000000000000000000000001` as `0x${string}`;

    const execCalldata = encodeFunctionData({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: [
        to as `0x${string}`,
        BigInt(0),                                    // value
        data as `0x${string}`,                        // data
        0,                                            // operation (CALL)
        BigInt(0),                                    // safeTxGas
        BigInt(0),                                    // baseGas
        BigInt(0),                                    // gasPrice
        '0x0000000000000000000000000000000000000000',  // gasToken
        '0x0000000000000000000000000000000000000000',  // refundReceiver
        preValidatedSig,                              // signatures
      ],
    });

    const txHash = await this.walletClient.sendTransaction({
      to: this.funderAddress as `0x${string}`,
      data: execCalldata,
      value: BigInt(0),
    });
    return txHash;
  }

  /**
   * Get a summary of redeemable positions (for Telegram command).
   */
  async getRedeemableSummary(): Promise<{ count: number; totalValue: number; positions: string[] }> {
    try {
      const apiPositions = await this.dataApi.getPositions(this.funderAddress, {
        limit: 200,
        sizeThreshold: 0.01,
      });

      const redeemable = apiPositions.filter(p => p.redeemable && parseFloat(p.size) > 0.001);
      let totalValue = 0;
      const positionLabels: string[] = [];

      for (const pos of redeemable) {
        const size = parseFloat(pos.size);
        const value = size; // Redeemable = $1 per share
        totalValue += value;
        positionLabels.push(`${pos.title?.slice(0, 35)} (${pos.outcome}) — ${size.toFixed(1)} shares ≈ $${value.toFixed(2)}`);
      }

      return { count: redeemable.length, totalValue, positions: positionLabels };
    } catch (err: any) {
      console.error('[Redeemer] Error fetching redeemable summary:', err?.message);
      return { count: 0, totalValue: 0, positions: [] };
    }
  }
}
