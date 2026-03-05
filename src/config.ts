import { CopyConfig, ConflictStrategy } from './types/index.js';
import { getConfigLoader, HOT_RELOADABLE_SETTINGS, RESTART_REQUIRED_SETTINGS } from './services/configLoader.js';

// Current merged config (updated on hot-reload)
let currentConfig: CopyConfig | null = null;

// Re-export for convenience
export { HOT_RELOADABLE_SETTINGS, RESTART_REQUIRED_SETTINGS };

// Default configuration
export const defaultConfig: CopyConfig = {
  wallets: [
    {
      address: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea',
      alias: 'RN1',
      enabled: true,
      allocation: 100, // 100% of calculated position size
    },
  ],
  pollingIntervalMs: 1000, // Poll every 1 second
  copyDelayMs: 500, // Delay before copying trade
  maxPositionSize: 10, // Max $10 per position (for $30 account)
  minTradeSize: 1, // Minimum $1 trade size
  userAccountSize: 30, // Your account size in USD
  maxPercentagePerTrade: 20, // Max 20% of your account per trade ($6 max)
  minProbability: 0.05, // Skip trades with <5% probability (lottery tickets)
  maxProbability: 0.95, // Skip trades with >95% probability (low upside)
  blacklistKeywords: [], // Keywords to block (set via BLACKLIST_KEYWORDS env var)
  whitelistKeywords: [], // Keywords to allow (set via WHITELIST_KEYWORDS env var) - if empty, all markets allowed
  maxOpenPositions: 0, // Max open positions (0 = unlimited)
  // Trading settings
  enableTrading: false, // Disabled by default - set to true to execute trades
  dryRun: true, // Simulate trades without executing (safe mode)
  privateKey: undefined, // Set via PRIVATE_KEY env var
  funderAddress: undefined, // Set via FUNDER_ADDRESS env var (optional)
  // Retry settings
  maxRetries: 3, // Max retry attempts for failed orders
  retryDelayMs: 2000, // Base delay between retries (uses exponential backoff)
  // Daily loss limit
  dailyLossLimit: 0, // Max daily loss in USD (0 = disabled)
  // Trailing stop loss
  trailingStopPercent: 15, // Sell if price drops 15% from peak (0 = disabled)
  trailingStopCheckIntervalMs: 60000, // Check every 60 seconds
  // Health check server
  healthCheckEnabled: false, // Enable HTTP health check server (set via HEALTH_CHECK_ENABLED)
  healthCheckPort: 3000, // Port for health check server (set via HEALTH_CHECK_PORT)
  // Conflict resolution
  conflictStrategy: 'first' as ConflictStrategy, // Strategy when traders make opposite trades: 'first' | 'skip' | 'majority' | 'highest_allocation'
  // Buy-only mode
  copySells: true, // Copy sell signals from tracked traders (set to false for buy-only mode)
  // Time-based exit
  maxHoldTimeHours: 0, // Auto-sell positions held longer than this (0 = disabled)
  // Web Dashboard
  dashboardEnabled: false, // Enable web dashboard (set via DASHBOARD_ENABLED)
  dashboardPort: 8080, // Port for web dashboard (set via DASHBOARD_PORT)
};

/**
 * Load config from environment variables only (internal helper)
 */
function loadConfigFromEnv(): CopyConfig {
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

  // Blacklist keywords (comma-separated)
  if (process.env.BLACKLIST_KEYWORDS) {
    config.blacklistKeywords = process.env.BLACKLIST_KEYWORDS
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0);
  }

  // Whitelist keywords (comma-separated) - if empty, all markets allowed
  if (process.env.WHITELIST_KEYWORDS) {
    config.whitelistKeywords = process.env.WHITELIST_KEYWORDS
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0);
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

  // Retry settings
  if (process.env.MAX_RETRIES) {
    config.maxRetries = parseInt(process.env.MAX_RETRIES, 10);
  }

  if (process.env.RETRY_DELAY_MS) {
    config.retryDelayMs = parseInt(process.env.RETRY_DELAY_MS, 10);
  }

  // Daily loss limit (0 = disabled)
  if (process.env.DAILY_LOSS_LIMIT) {
    config.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT);
  }

  // Max open positions (0 = unlimited)
  if (process.env.MAX_OPEN_POSITIONS) {
    config.maxOpenPositions = parseInt(process.env.MAX_OPEN_POSITIONS, 10);
  }

  // Trailing stop loss (0 = disabled)
  if (process.env.TRAILING_STOP_PERCENT) {
    config.trailingStopPercent = parseFloat(process.env.TRAILING_STOP_PERCENT);
  }

  // Trailing stop check interval
  if (process.env.TRAILING_STOP_CHECK_INTERVAL_MS) {
    config.trailingStopCheckIntervalMs = parseInt(process.env.TRAILING_STOP_CHECK_INTERVAL_MS, 10);
  }

  // Health check server
  if (process.env.HEALTH_CHECK_ENABLED === 'true') {
    config.healthCheckEnabled = true;
  }

  if (process.env.HEALTH_CHECK_PORT) {
    config.healthCheckPort = parseInt(process.env.HEALTH_CHECK_PORT, 10);
  }

  // Conflict resolution strategy
  if (process.env.CONFLICT_STRATEGY) {
    const strategy = process.env.CONFLICT_STRATEGY.toLowerCase() as ConflictStrategy;
    if (['first', 'skip', 'majority', 'highest_allocation'].includes(strategy)) {
      config.conflictStrategy = strategy;
    } else {
      console.warn(`[Config] Invalid CONFLICT_STRATEGY "${process.env.CONFLICT_STRATEGY}", using default "first"`);
    }
  }

  // Buy-only mode (COPY_SELLS=false disables copying sell signals)
  if (process.env.COPY_SELLS === 'false') {
    config.copySells = false;
  }

  // Time-based exit (0 = disabled)
  if (process.env.MAX_HOLD_TIME_HOURS) {
    config.maxHoldTimeHours = parseFloat(process.env.MAX_HOLD_TIME_HOURS);
  }

  // Web Dashboard
  if (process.env.DASHBOARD_ENABLED === 'true') {
    config.dashboardEnabled = true;
  }

  if (process.env.DASHBOARD_PORT) {
    config.dashboardPort = parseInt(process.env.DASHBOARD_PORT, 10);
  }

  return config;
}

/**
 * Load config with priority: config.json > .env > defaults
 *
 * Config file settings override environment variables.
 * Use getConfig() to access the current merged config.
 */
export function loadConfig(): CopyConfig {
  // Start with env-based config
  const envConfig = loadConfigFromEnv();

  // Try to load from config.json
  const configLoader = getConfigLoader();
  const fileResult = configLoader.loadFromFile();

  // Log any validation errors
  if (fileResult.errors.length > 0) {
    console.warn('[Config] Config file validation errors:');
    fileResult.errors.forEach(e => console.warn(`  - ${e}`));
  }

  // Merge: file config overrides env config
  const mergedConfig = { ...envConfig };

  if (fileResult.source === 'file') {
    // Track which settings came from file vs env
    const fileSettings: string[] = [];
    const envOverridden: string[] = [];

    for (const [key, value] of Object.entries(fileResult.config)) {
      if (value !== undefined) {
        const envValue = (envConfig as any)[key];
        const defaultValue = (defaultConfig as any)[key];

        // Check if env had a different value than default
        if (JSON.stringify(envValue) !== JSON.stringify(defaultValue)) {
          envOverridden.push(key);
        }

        (mergedConfig as any)[key] = value;
        fileSettings.push(key);
      }
    }

    // Log config sources
    if (fileSettings.length > 0) {
      console.log('[Config] Loaded from config.json:');
      fileSettings.forEach(s => console.log(`  - ${s}`));
    }

    if (envOverridden.length > 0) {
      console.log('[Config] Environment values overridden by config.json:');
      envOverridden.forEach(s => console.log(`  - ${s}`));
    }
  } else {
    console.log('[Config] No config.json found, using environment variables');
  }

  // Auto-adjust polling interval based on wallet count to respect rate limits
  // Polymarket /trades limit: 200 req/10s = 20 req/sec
  // Target: stay under 50% of limit (10 req/sec max)
  const enabledWallets = mergedConfig.wallets.filter(w => w.enabled).length;
  const minIntervalMs = Math.ceil((enabledWallets / 10) * 1000); // 10 wallets = 1s min
  if (mergedConfig.pollingIntervalMs < minIntervalMs) {
    console.log(`[Config] Auto-adjusted polling to ${minIntervalMs}ms for ${enabledWallets} wallets (rate limit protection)`);
    mergedConfig.pollingIntervalMs = minIntervalMs;
  }

  // Store as current config
  currentConfig = mergedConfig;

  return mergedConfig;
}

/**
 * Get the current merged config
 * Returns the last loaded config, or loads it if not yet loaded
 */
export function getConfig(): CopyConfig {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

/**
 * Update the current config with new values (used for hot-reload)
 * Only updates hot-reloadable settings
 */
export function updateConfig(newValues: Partial<CopyConfig>): void {
  if (!currentConfig) {
    currentConfig = loadConfig();
  }

  const updated: string[] = [];

  for (const key of HOT_RELOADABLE_SETTINGS) {
    if (key in newValues && (newValues as any)[key] !== undefined) {
      (currentConfig as any)[key] = (newValues as any)[key];
      updated.push(key);
    }
  }

  if (updated.length > 0) {
    console.log('[Config] Hot-reloaded settings:');
    updated.forEach(s => console.log(`  - ${s}`));
  }

  // Check for settings that require restart
  const requiresRestart: string[] = [];
  for (const key of RESTART_REQUIRED_SETTINGS) {
    if (key in newValues && (newValues as any)[key] !== undefined) {
      const currentVal = JSON.stringify((currentConfig as any)[key]);
      const newVal = JSON.stringify((newValues as any)[key]);
      if (currentVal !== newVal) {
        requiresRestart.push(key);
      }
    }
  }

  if (requiresRestart.length > 0) {
    console.log('[Config] Settings changed that require restart:');
    requiresRestart.forEach(s => console.log(`  - ${s}`));
    console.log('[Config] Restart the bot to apply these changes');
  }
}
