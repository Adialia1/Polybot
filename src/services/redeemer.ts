import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { DataApiClient } from '../api/dataApi.js';
import { ClobApiClient } from '../api/clobApi.js';
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
  error?: string;
}

export interface RedeemerConfig {
  privateKey: string;
  funderAddress?: string;
  signatureType: number; // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
  dryRun?: boolean;
  rpcUrl?: string;
}

export class Redeemer {
  private dataApi: DataApiClient;
  private clobApi: ClobApiClient;
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
    this.clobApi = new ClobApiClient();

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
   */
  async redeemAll(): Promise<RedeemResult[]> {
    if (this.config.dryRun) {
      console.log('[Redeemer] DRY RUN — skipping on-chain redemption');
      return [];
    }

    const results: RedeemResult[] = [];

    try {
      const apiPositions = await this.dataApi.getPositions(this.funderAddress, {
        limit: 200,
        sizeThreshold: 0.01,
      });

      const redeemable = apiPositions.filter(p => p.redeemable && parseFloat(p.size) > 0.001);

      if (redeemable.length === 0) {
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

          // Determine market type (neg risk or standard) via CLOB API
          const isNegRisk = await this.checkNegRisk(firstPos.asset);
          const result = isNegRisk
            ? await this.redeemNegRisk(conditionId, positions)
            : await this.redeemStandard(conditionId, positions);

          if (result.success) {
            console.log(`[Redeemer] ✅ Redeemed: ${label} — tx: ${result.txHash?.slice(0, 16)}...`);

            // Remove from state manager
            for (const pos of positions) {
              const localPos = this.stateManager.getPosition(pos.asset);
              if (localPos) {
                this.stateManager.updatePosition(pos.asset, -localPos.size, 1.0);
                const pnl = (1.0 - localPos.avgPrice) * localPos.size;
                this.stateManager.updateDailyPnL(pnl);
              }
            }
          } else {
            console.log(`[Redeemer] ❌ Failed: ${label} — ${result.error}`);
          }

          results.push(result);
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
   * Check if a token belongs to a neg risk market via CLOB API.
   */
  private async checkNegRisk(tokenId: string): Promise<boolean> {
    try {
      // The ClobApiClient wraps the CLOB client which has getNegRisk
      const url = `https://clob.polymarket.com/neg-risk?token_id=${tokenId}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return data?.neg_risk === true;
      }
    } catch {
      // If we can't determine, default to standard (safer — standard redeem
      // on a neg-risk market will just revert without losing funds)
    }
    return false;
  }

  /**
   * Redeem via standard ConditionalTokens contract.
   * Uses eth_call simulation first to avoid wasting gas on revert.
   */
  private async redeemStandard(
    conditionId: string,
    positions: any[],
  ): Promise<RedeemResult> {
    const firstPos = positions[0];
    const title = firstPos.title || 'Unknown';

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

    // Simulate first to avoid wasting gas
    const txTarget = this.getTxTarget(CTF_ADDRESS, redeemCalldata);
    try {
      await this.publicClient.call({
        account: this.account.address,
        to: txTarget.to as `0x${string}`,
        data: txTarget.data as `0x${string}`,
      });
    } catch (simErr: any) {
      return {
        asset: firstPos.asset,
        title,
        conditionId,
        success: false,
        error: `Simulation failed: ${simErr?.message?.slice(0, 100)}`,
      };
    }

    return await this.submitTx(CTF_ADDRESS, redeemCalldata, firstPos.asset, title, conditionId);
  }

  /**
   * Redeem via NegRiskAdapter for neg-risk markets.
   * Builds a 2-element amounts array indexed by outcomeIndex.
   */
  private async redeemNegRisk(
    conditionId: string,
    positions: any[],
  ): Promise<RedeemResult> {
    const firstPos = positions[0];
    const title = firstPos.title || 'Unknown';

    // Build 2-element amounts array: [yesAmount, noAmount]
    // outcomeIndex 0 = YES, outcomeIndex 1 = NO
    const yesPos = positions.find((p: any) => p.outcomeIndex === 0);
    const noPos = positions.find((p: any) => p.outcomeIndex === 1);
    const amounts = [
      yesPos ? parseUnits(parseFloat(yesPos.size).toFixed(6), 6) : BigInt(0),
      noPos ? parseUnits(parseFloat(noPos.size).toFixed(6), 6) : BigInt(0),
    ];

    const redeemCalldata = encodeFunctionData({
      abi: NEG_RISK_REDEEM_ABI,
      functionName: 'redeemPositions',
      args: [
        conditionId as `0x${string}`,
        amounts,
      ],
    });

    // Simulate first
    const txTarget = this.getTxTarget(NEG_RISK_ADAPTER, redeemCalldata);
    try {
      await this.publicClient.call({
        account: this.account.address,
        to: txTarget.to as `0x${string}`,
        data: txTarget.data as `0x${string}`,
      });
    } catch (simErr: any) {
      return {
        asset: firstPos.asset,
        title,
        conditionId,
        success: false,
        error: `NegRisk simulation failed: ${simErr?.message?.slice(0, 100)}`,
      };
    }

    return await this.submitTx(NEG_RISK_ADAPTER, redeemCalldata, firstPos.asset, title, conditionId);
  }

  /**
   * Get the actual tx target (wraps calldata for proxy/safe if needed).
   */
  private getTxTarget(contractAddr: string, calldata: string): { to: string; data: string } {
    if (this.config.signatureType === 1) {
      // POLY_PROXY: wrap in ProxyWalletFactory.proxy()
      const proxyData = encodeFunctionData({
        abi: PROXY_WALLET_FACTORY_ABI,
        functionName: 'proxy',
        args: [[{ to: contractAddr as `0x${string}`, value: BigInt(0), data: calldata as `0x${string}` }]],
      });
      return { to: PROXY_WALLET_FACTORY, data: proxyData };
    }
    // EOA or Safe: direct call (Safe simulation may not work via eth_call)
    return { to: contractAddr, data: calldata };
  }

  /**
   * Submit the actual on-chain transaction.
   */
  private async submitTx(
    contractAddr: string,
    calldata: string,
    asset: string,
    title: string,
    conditionId: string,
  ): Promise<RedeemResult> {
    try {
      let txHash: string;

      if (this.config.signatureType === 1) {
        txHash = await this.executeViaProxyFactory(contractAddr, calldata);
      } else if (this.config.signatureType === 2) {
        txHash = await this.executeViaSafe(contractAddr, calldata);
      } else {
        txHash = await this.executeDirect(contractAddr, calldata);
      }

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: 30000,
      });

      return {
        asset,
        title,
        conditionId,
        success: receipt.status === 'success',
        txHash,
        error: receipt.status !== 'success' ? 'Transaction reverted' : undefined,
      };
    } catch (err: any) {
      return {
        asset,
        title,
        conditionId,
        success: false,
        error: err?.message || 'Transaction failed',
      };
    }
  }

  /**
   * Execute a contract call directly (EOA mode).
   */
  private async executeDirect(to: string, data: string): Promise<string> {
    return await this.walletClient.sendTransaction({
      to: to as `0x${string}`,
      data: data as `0x${string}`,
      value: BigInt(0),
    });
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

    return await this.walletClient.sendTransaction({
      to: PROXY_WALLET_FACTORY,
      data: proxyCalldata as `0x${string}`,
      value: BigInt(0),
    });
  }

  /**
   * Execute a contract call through a Gnosis Safe (GNOSIS_SAFE mode).
   * Uses pre-validated signature: 32-byte padded address + 32 zero bytes + 0x01
   */
  private async executeViaSafe(to: string, data: string): Promise<string> {
    // Pre-validated signature (65 bytes): {32-byte padded address}{32 zero bytes}{01}
    const ownerPadded = this.account.address.toLowerCase().replace('0x', '').padStart(64, '0');
    const preValidatedSig = `0x${ownerPadded}${'0'.repeat(64)}01` as `0x${string}`;

    const execCalldata = encodeFunctionData({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      args: [
        to as `0x${string}`,
        BigInt(0),
        data as `0x${string}`,
        0,                                            // operation (CALL)
        BigInt(0),
        BigInt(0),
        BigInt(0),
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
        preValidatedSig,
      ],
    });

    return await this.walletClient.sendTransaction({
      to: this.funderAddress as `0x${string}`,
      data: execCalldata,
      value: BigInt(0),
    });
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
        totalValue += size;
        positionLabels.push(`${pos.title?.slice(0, 35)} (${pos.outcome}) — ${size.toFixed(1)} shares ≈ $${size.toFixed(2)}`);
      }

      return { count: redeemable.length, totalValue, positions: positionLabels };
    } catch (err: any) {
      console.error('[Redeemer] Error fetching redeemable summary:', err?.message);
      return { count: 0, totalValue: 0, positions: [] };
    }
  }
}
