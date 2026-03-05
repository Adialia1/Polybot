import { EventEmitter } from 'events';
import { DataApiClient } from '../api/dataApi.js';
import { GammaApiClient } from '../api/gammaApi.js';
import { Trade, TradeSignal, WalletConfig } from '../types/index.js';

export interface TradeMonitorConfig {
  wallets: WalletConfig[];
  pollingIntervalMs: number;
}

export class TradeMonitor extends EventEmitter {
  private dataApi: DataApiClient;
  private gammaApi: GammaApiClient;
  private config: TradeMonitorConfig;
  private lastSeenTrades: Map<string, number> = new Map(); // wallet -> last timestamp
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  constructor(config: TradeMonitorConfig) {
    super();
    this.config = config;
    this.dataApi = new DataApiClient();
    this.gammaApi = new GammaApiClient();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Monitor] Already running');
      return;
    }

    console.log('[Monitor] Starting trade monitor...');
    this.isRunning = true;

    // Initialize last seen timestamps
    for (const wallet of this.config.wallets) {
      if (!wallet.enabled) continue;

      console.log(`[Monitor] Initializing tracking for ${wallet.alias} (${wallet.address})`);

      // Get the most recent activity to set initial timestamp
      // Using /activity endpoint for real-time data (faster than /trades)
      const trades = await this.dataApi.getActivity(wallet.address, { limit: 1 });
      if (trades.length > 0) {
        this.lastSeenTrades.set(wallet.address, trades[0].timestamp);
        console.log(`[Monitor] Last trade for ${wallet.alias}: ${new Date(trades[0].timestamp * 1000).toISOString()}`);
      } else {
        // Use current time in seconds
        this.lastSeenTrades.set(wallet.address, Math.floor(Date.now() / 1000));
        console.log(`[Monitor] No trades found for ${wallet.alias}, starting from now`);
      }

      // Start polling for this wallet
      this.startPolling(wallet);
    }

    console.log('[Monitor] Trade monitor started');
  }

  private startPolling(wallet: WalletConfig): void {
    const poll = async () => {
      if (!this.isRunning) return;

      try {
        await this.checkForNewTrades(wallet);
      } catch (error) {
        console.error(`[Monitor] Error polling ${wallet.alias}:`, error);
        this.emit('error', { wallet, error });
      }
    };

    // Initial poll
    poll();

    // Set up interval
    const interval = setInterval(poll, this.config.pollingIntervalMs);
    this.pollingIntervals.set(wallet.address, interval);
  }

  private async checkForNewTrades(wallet: WalletConfig): Promise<void> {
    // Timestamps are in seconds
    const lastTimestamp = this.lastSeenTrades.get(wallet.address) || Math.floor(Date.now() / 1000);

    // Use /activity endpoint for real-time data
    const trades = await this.dataApi.getActivity(wallet.address, { limit: 20 });

    // Filter to new trades only
    const newTrades = trades.filter(trade => trade.timestamp > lastTimestamp);

    if (newTrades.length > 0) {
      // Sort oldest first so we process in order
      newTrades.sort((a, b) => a.timestamp - b.timestamp);

      // Update last seen timestamp
      const latestTimestamp = Math.max(...newTrades.map(t => t.timestamp));
      this.lastSeenTrades.set(wallet.address, latestTimestamp);

      // Emit signals for each new trade
      for (const trade of newTrades) {
        const signal: TradeSignal = {
          type: 'NEW_TRADE',
          trade,
          detectedAt: Date.now(),
        };

        console.log(`[Monitor] New trade detected from ${wallet.alias}:`);
        console.log(`  Market: ${trade.title}`);
        console.log(`  Side: ${trade.side}`);
        console.log(`  Outcome: ${trade.outcome}`);
        console.log(`  Size: ${trade.size}`);
        console.log(`  Price: ${trade.price}`);
        console.log(`  Time: ${new Date(trade.timestamp * 1000).toISOString()}`);

        this.emit('trade', signal, wallet);
      }
    }
  }

  stop(): void {
    console.log('[Monitor] Stopping trade monitor...');
    this.isRunning = false;

    for (const [address, interval] of this.pollingIntervals) {
      clearInterval(interval);
      this.pollingIntervals.delete(address);
    }

    console.log('[Monitor] Trade monitor stopped');
  }

  addWallet(wallet: WalletConfig): void {
    const existing = this.config.wallets.find(w => w.address === wallet.address);
    if (existing) {
      console.log(`[Monitor] Wallet ${wallet.address} already exists`);
      return;
    }

    this.config.wallets.push(wallet);
    console.log(`[Monitor] Added wallet ${wallet.alias}`);

    if (this.isRunning && wallet.enabled) {
      this.lastSeenTrades.set(wallet.address, Math.floor(Date.now() / 1000));
      this.startPolling(wallet);
    }
  }

  removeWallet(address: string): void {
    const index = this.config.wallets.findIndex(w => w.address === address);
    if (index === -1) {
      console.log(`[Monitor] Wallet ${address} not found`);
      return;
    }

    const wallet = this.config.wallets[index];
    this.config.wallets.splice(index, 1);
    this.lastSeenTrades.delete(address);

    const interval = this.pollingIntervals.get(address);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(address);
    }

    console.log(`[Monitor] Removed wallet ${wallet.alias}`);
  }

  getStatus(): {
    isRunning: boolean;
    wallets: Array<{ alias: string; address: string; lastSeen: number | null }>;
  } {
    return {
      isRunning: this.isRunning,
      wallets: this.config.wallets.map(w => ({
        alias: w.alias,
        address: w.address,
        lastSeen: this.lastSeenTrades.get(w.address) || null,
      })),
    };
  }
}
