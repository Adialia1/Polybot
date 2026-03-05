import { CopyConfig } from './types/index.js';

// Default configuration
export const defaultConfig: CopyConfig = {
  wallets: [
    {
      address: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea',
      alias: 'RN1',
      enabled: true,
    },
    {
      address: '0x6480542954b70a674a74bd1a6015dec362dc8dc5',
      alias: 'tripping',
      enabled: true,
    },
  ],
  pollingIntervalMs: 1000, // Poll every 1 second
  copyDelayMs: 500, // Delay before copying trade
  maxPositionSize: 100, // Max $100 per position
  minTradeSize: 5, // Minimum $5 trade size
  userAccountSize: 1000, // Your account size in USD
  maxPercentagePerTrade: 10, // Max 10% of your account per trade
  minProbability: 0.05, // Skip trades with <5% probability (lottery tickets)
  maxProbability: 0.95, // Skip trades with >95% probability (low upside)
  // Trading settings
  enableTrading: false, // Disabled by default - set to true to execute trades
  dryRun: true, // Simulate trades without executing (safe mode)
  privateKey: undefined, // Set via PRIVATE_KEY env var
  funderAddress: undefined, // Set via FUNDER_ADDRESS env var (optional)
};

export function loadConfig(): CopyConfig {
  const config = { ...defaultConfig };

  // Load wallets from environment variable if set
  const walletsEnv = process.env.TRACK_WALLETS;
  if (walletsEnv) {
    try {
      const wallets = JSON.parse(walletsEnv);
      if (Array.isArray(wallets)) {
        config.wallets = wallets;
      }
    } catch {
      console.error('Failed to parse TRACK_WALLETS environment variable');
    }
  }

  // Override from env vars
  if (process.env.POLLING_INTERVAL_MS) {
    config.pollingIntervalMs = parseInt(process.env.POLLING_INTERVAL_MS, 10);
  }

  // Auto-adjust polling interval based on wallet count to respect rate limits
  // Polymarket /trades limit: 200 req/10s = 20 req/sec
  // Target: stay under 50% of limit (10 req/sec max)
  const enabledWallets = config.wallets.filter(w => w.enabled).length;
  const minIntervalMs = Math.ceil((enabledWallets / 10) * 1000); // 10 wallets = 1s min
  if (config.pollingIntervalMs < minIntervalMs) {
    console.log(`[Config] Auto-adjusted polling to ${minIntervalMs}ms for ${enabledWallets} wallets (rate limit protection)`);
    config.pollingIntervalMs = minIntervalMs;
  }

  if (process.env.COPY_DELAY_MS) {
    config.copyDelayMs = parseInt(process.env.COPY_DELAY_MS, 10);
  }

  if (process.env.MAX_POSITION_SIZE) {
    config.maxPositionSize = parseFloat(process.env.MAX_POSITION_SIZE);
  }

  if (process.env.MIN_TRADE_SIZE) {
    config.minTradeSize = parseFloat(process.env.MIN_TRADE_SIZE);
  }

  if (process.env.USER_ACCOUNT_SIZE) {
    config.userAccountSize = parseFloat(process.env.USER_ACCOUNT_SIZE);
  }

  if (process.env.MAX_PERCENTAGE_PER_TRADE) {
    config.maxPercentagePerTrade = parseFloat(process.env.MAX_PERCENTAGE_PER_TRADE);
  }

  if (process.env.MIN_PROBABILITY) {
    config.minProbability = parseFloat(process.env.MIN_PROBABILITY);
  }

  if (process.env.MAX_PROBABILITY) {
    config.maxProbability = parseFloat(process.env.MAX_PROBABILITY);
  }

  // Trading settings
  if (process.env.ENABLE_TRADING === 'true') {
    config.enableTrading = true;
  }

  if (process.env.DRY_RUN === 'false') {
    config.dryRun = false;
  }

  if (process.env.PRIVATE_KEY) {
    config.privateKey = process.env.PRIVATE_KEY;
  }

  if (process.env.FUNDER_ADDRESS) {
    config.funderAddress = process.env.FUNDER_ADDRESS;
  }

  return config;
}
