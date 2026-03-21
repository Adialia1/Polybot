import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { CopyConfig, WalletConfig, ConflictStrategy } from '../types/index.js';

// Path to config file (same directory as state.json)
const CONFIG_FILE_PATH = path.join(process.cwd(), 'data', 'config.json');

/**
 * Settings that can be hot-reloaded without restart
 */
export const HOT_RELOADABLE_SETTINGS = [
  'maxPositionSize',
  'minTradeSize',
  'maxPercentagePerTrade',
  'fixedTradePercent',
  'minProbability',
  'maxProbability',
  'blacklistKeywords',
  'whitelistKeywords',
  'maxOpenPositions',
  'dryRun',
  'dailyLossLimit',
  'stopLossPercent',
  'takeProfitPercent',
  'trailingStopPercent',
  'trailingStopCheckIntervalMs',
  'conflictStrategy',
  'copySells',
  'maxHoldTimeHours',
  'copyDelayMs',
  'maxRetries',
  'retryDelayMs',
] as const;

/**
 * Settings that require a restart to take effect
 */
export const RESTART_REQUIRED_SETTINGS = [
  'wallets',
  'pollingIntervalMs',
  'enableTrading',
  'privateKey',
  'funderAddress',
  'healthCheckEnabled',
  'healthCheckPort',
  'userAccountSize',
  'dashboardEnabled',
  'dashboardPort',
] as const;

/**
 * JSON config file schema (subset of CopyConfig with friendlier names)
 */
export interface ConfigFileSchema {
  // Core settings
  dryRun?: boolean;
  enableTrading?: boolean;

  // Position sizing
  maxPositionSize?: number;
  minTradeSize?: number;
  userAccountSize?: number;
  maxPercentagePerTrade?: number;
  fixedTradePercent?: number; // If set, use fixed % per trade instead of proportional
  addOnSize?: number; // Smaller trade size when adding to existing positions
  maxPositionValue?: number; // Max total dollars spent per position (0 = unlimited)

  // Wallets to track
  trackWallets?: Array<{
    address: string;
    alias: string;
    enabled?: boolean;
    allocation?: number;
  }>;

  // Probability filters
  minProbability?: number;
  maxProbability?: number;

  // Market filters
  blacklistKeywords?: string[];
  whitelistKeywords?: string[];

  // Position limits
  maxOpenPositions?: number;

  // Timing
  pollingIntervalMs?: number;
  copyDelayMs?: number;

  // Risk management
  dailyLossLimit?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  trailingStopPercent?: number;
  trailingStopCheckIntervalMs?: number;
  maxHoldTimeHours?: number;

  // Retry settings
  maxRetries?: number;
  retryDelayMs?: number;

  // Conflict resolution
  conflictStrategy?: ConflictStrategy;

  // Buy-only mode
  copySells?: boolean;

  // Health check
  healthCheckEnabled?: boolean;
  healthCheckPort?: number;

  // Web Dashboard
  dashboardEnabled?: boolean;
  dashboardPort?: number;

  // Trade filters
  maxPriceDiffPercent?: number;
  orderSlippagePercent?: number;
  minTraderTradeUsd?: number;

  // Wallet settings
  signatureType?: number;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;
}

/**
 * Result of loading config
 */
export interface ConfigLoadResult {
  config: Partial<CopyConfig>;
  source: 'file' | 'none';
  errors: string[];
}

/**
 * ConfigLoader - Loads and watches config.json for changes
 *
 * Features:
 * - Load config from data/config.json
 * - Validate config schema
 * - Watch for file changes and emit 'configReload' event
 * - Merge config file settings with env vars (file takes precedence)
 */
export class ConfigLoader extends EventEmitter {
  private currentConfig: ConfigFileSchema | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastLoadTime = 0;

  constructor() {
    super();
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return CONFIG_FILE_PATH;
  }

  /**
   * Check if config file exists
   */
  configFileExists(): boolean {
    return fs.existsSync(CONFIG_FILE_PATH);
  }

  /**
   * Load config from file
   */
  loadFromFile(): ConfigLoadResult {
    const errors: string[] = [];

    if (!this.configFileExists()) {
      return {
        config: {},
        source: 'none',
        errors: [],
      };
    }

    try {
      const content = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(content) as ConfigFileSchema;

      // Validate and transform to CopyConfig format
      const config = this.transformConfig(parsed, errors);

      this.currentConfig = parsed;
      this.lastLoadTime = Date.now();

      return {
        config,
        source: 'file',
        errors,
      };
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        errors.push(`Invalid JSON in config file: ${err.message}`);
      } else {
        errors.push(`Failed to read config file: ${err.message}`);
      }

      return {
        config: {},
        source: 'none',
        errors,
      };
    }
  }

  /**
   * Transform ConfigFileSchema to CopyConfig format with validation
   */
  private transformConfig(schema: ConfigFileSchema, errors: string[]): Partial<CopyConfig> {
    const config: Partial<CopyConfig> = {};

    // Boolean settings
    if (typeof schema.dryRun === 'boolean') {
      config.dryRun = schema.dryRun;
    }

    if (typeof schema.enableTrading === 'boolean') {
      config.enableTrading = schema.enableTrading;
    }

    if (typeof schema.copySells === 'boolean') {
      config.copySells = schema.copySells;
    }

    if (typeof schema.healthCheckEnabled === 'boolean') {
      config.healthCheckEnabled = schema.healthCheckEnabled;
    }

    // Number settings with validation
    if (schema.maxPositionSize !== undefined) {
      if (typeof schema.maxPositionSize === 'number' && schema.maxPositionSize > 0) {
        config.maxPositionSize = schema.maxPositionSize;
      } else {
        errors.push('maxPositionSize must be a positive number');
      }
    }

    if (schema.minTradeSize !== undefined) {
      if (typeof schema.minTradeSize === 'number' && schema.minTradeSize >= 0) {
        config.minTradeSize = schema.minTradeSize;
      } else {
        errors.push('minTradeSize must be a non-negative number');
      }
    }

    if (schema.userAccountSize !== undefined) {
      if (typeof schema.userAccountSize === 'number' && schema.userAccountSize > 0) {
        config.userAccountSize = schema.userAccountSize;
      } else {
        errors.push('userAccountSize must be a positive number');
      }
    }

    if (schema.maxPercentagePerTrade !== undefined) {
      if (typeof schema.maxPercentagePerTrade === 'number' && schema.maxPercentagePerTrade > 0 && schema.maxPercentagePerTrade <= 100) {
        config.maxPercentagePerTrade = schema.maxPercentagePerTrade;
      } else {
        errors.push('maxPercentagePerTrade must be between 0 and 100');
      }
    }

    if (schema.fixedTradePercent !== undefined) {
      if (typeof schema.fixedTradePercent === 'number' && schema.fixedTradePercent >= 0 && schema.fixedTradePercent <= 100) {
        (config as any).fixedTradePercent = schema.fixedTradePercent;
      } else {
        errors.push('fixedTradePercent must be between 0 and 100');
      }
    }

    if (schema.addOnSize !== undefined) {
      if (typeof schema.addOnSize === 'number' && schema.addOnSize >= 0) {
        (config as any).addOnSize = schema.addOnSize;
      } else {
        errors.push('addOnSize must be a non-negative number');
      }
    }

    if (schema.maxPositionValue !== undefined) {
      if (typeof schema.maxPositionValue === 'number' && schema.maxPositionValue >= 0) {
        (config as any).maxPositionValue = schema.maxPositionValue;
      } else {
        errors.push('maxPositionValue must be a non-negative number');
      }
    }

    if (schema.minProbability !== undefined) {
      if (typeof schema.minProbability === 'number' && schema.minProbability >= 0 && schema.minProbability <= 1) {
        config.minProbability = schema.minProbability;
      } else {
        errors.push('minProbability must be between 0 and 1');
      }
    }

    if (schema.maxProbability !== undefined) {
      if (typeof schema.maxProbability === 'number' && schema.maxProbability >= 0 && schema.maxProbability <= 1) {
        config.maxProbability = schema.maxProbability;
      } else {
        errors.push('maxProbability must be between 0 and 1');
      }
    }

    if (schema.maxOpenPositions !== undefined) {
      if (typeof schema.maxOpenPositions === 'number' && schema.maxOpenPositions >= 0 && Number.isInteger(schema.maxOpenPositions)) {
        config.maxOpenPositions = schema.maxOpenPositions;
      } else {
        errors.push('maxOpenPositions must be a non-negative integer');
      }
    }

    if (schema.pollingIntervalMs !== undefined) {
      if (typeof schema.pollingIntervalMs === 'number' && schema.pollingIntervalMs >= 100) {
        config.pollingIntervalMs = schema.pollingIntervalMs;
      } else {
        errors.push('pollingIntervalMs must be at least 100');
      }
    }

    if (schema.copyDelayMs !== undefined) {
      if (typeof schema.copyDelayMs === 'number' && schema.copyDelayMs >= 0) {
        config.copyDelayMs = schema.copyDelayMs;
      } else {
        errors.push('copyDelayMs must be a non-negative number');
      }
    }

    if (schema.dailyLossLimit !== undefined) {
      if (typeof schema.dailyLossLimit === 'number' && schema.dailyLossLimit >= 0) {
        config.dailyLossLimit = schema.dailyLossLimit;
      } else {
        errors.push('dailyLossLimit must be a non-negative number');
      }
    }

    if (schema.stopLossPercent !== undefined) {
      if (typeof schema.stopLossPercent === 'number' && schema.stopLossPercent < 0) {
        config.stopLossPercent = schema.stopLossPercent;
      } else {
        errors.push('stopLossPercent must be a negative number (e.g., -25)');
      }
    }

    if (schema.takeProfitPercent !== undefined) {
      if (typeof schema.takeProfitPercent === 'number' && schema.takeProfitPercent > 0) {
        config.takeProfitPercent = schema.takeProfitPercent;
      } else {
        errors.push('takeProfitPercent must be a positive number (e.g., 100)');
      }
    }

    if (schema.trailingStopPercent !== undefined) {
      if (typeof schema.trailingStopPercent === 'number' && schema.trailingStopPercent >= 0 && schema.trailingStopPercent <= 100) {
        config.trailingStopPercent = schema.trailingStopPercent;
      } else {
        errors.push('trailingStopPercent must be between 0 and 100');
      }
    }

    if (schema.trailingStopCheckIntervalMs !== undefined) {
      if (typeof schema.trailingStopCheckIntervalMs === 'number' && schema.trailingStopCheckIntervalMs >= 1000) {
        config.trailingStopCheckIntervalMs = schema.trailingStopCheckIntervalMs;
      } else {
        errors.push('trailingStopCheckIntervalMs must be at least 1000');
      }
    }

    if (schema.maxHoldTimeHours !== undefined) {
      if (typeof schema.maxHoldTimeHours === 'number' && schema.maxHoldTimeHours >= 0) {
        config.maxHoldTimeHours = schema.maxHoldTimeHours;
      } else {
        errors.push('maxHoldTimeHours must be a non-negative number');
      }
    }

    if (schema.maxRetries !== undefined) {
      if (typeof schema.maxRetries === 'number' && schema.maxRetries >= 0 && Number.isInteger(schema.maxRetries)) {
        config.maxRetries = schema.maxRetries;
      } else {
        errors.push('maxRetries must be a non-negative integer');
      }
    }

    if (schema.retryDelayMs !== undefined) {
      if (typeof schema.retryDelayMs === 'number' && schema.retryDelayMs >= 0) {
        config.retryDelayMs = schema.retryDelayMs;
      } else {
        errors.push('retryDelayMs must be a non-negative number');
      }
    }

    if (schema.healthCheckPort !== undefined) {
      if (typeof schema.healthCheckPort === 'number' && schema.healthCheckPort >= 1 && schema.healthCheckPort <= 65535 && Number.isInteger(schema.healthCheckPort)) {
        config.healthCheckPort = schema.healthCheckPort;
      } else {
        errors.push('healthCheckPort must be a valid port number (1-65535)');
      }
    }

    // Dashboard settings
    if (typeof schema.dashboardEnabled === 'boolean') {
      (config as any).dashboardEnabled = schema.dashboardEnabled;
    }

    if (schema.dashboardPort !== undefined) {
      if (typeof schema.dashboardPort === 'number' && schema.dashboardPort >= 1 && schema.dashboardPort <= 65535 && Number.isInteger(schema.dashboardPort)) {
        (config as any).dashboardPort = schema.dashboardPort;
      } else {
        errors.push('dashboardPort must be a valid port number (1-65535)');
      }
    }

    // Trade filter settings
    if (schema.maxPriceDiffPercent !== undefined) {
      (config as any).maxPriceDiffPercent = schema.maxPriceDiffPercent;
    }
    if (schema.orderSlippagePercent !== undefined) {
      (config as any).orderSlippagePercent = schema.orderSlippagePercent;
    }
    if (schema.minTraderTradeUsd !== undefined) {
      (config as any).minTraderTradeUsd = schema.minTraderTradeUsd;
    }
    if (schema.signatureType !== undefined) {
      (config as any).signatureType = schema.signatureType;
    }
    if (schema.telegramBotToken !== undefined) {
      (config as any).telegramBotToken = schema.telegramBotToken;
    }
    if (schema.telegramChatId !== undefined) {
      (config as any).telegramChatId = schema.telegramChatId;
    }

    // String array settings
    if (schema.blacklistKeywords !== undefined) {
      if (Array.isArray(schema.blacklistKeywords) && schema.blacklistKeywords.every(k => typeof k === 'string')) {
        config.blacklistKeywords = schema.blacklistKeywords.filter(k => k.length > 0);
      } else {
        errors.push('blacklistKeywords must be an array of strings');
      }
    }

    if (schema.whitelistKeywords !== undefined) {
      if (Array.isArray(schema.whitelistKeywords) && schema.whitelistKeywords.every(k => typeof k === 'string')) {
        config.whitelistKeywords = schema.whitelistKeywords.filter(k => k.length > 0);
      } else {
        errors.push('whitelistKeywords must be an array of strings');
      }
    }

    // Conflict strategy
    if (schema.conflictStrategy !== undefined) {
      const validStrategies: ConflictStrategy[] = ['first', 'skip', 'majority', 'highest_allocation'];
      if (validStrategies.includes(schema.conflictStrategy)) {
        config.conflictStrategy = schema.conflictStrategy;
      } else {
        errors.push(`conflictStrategy must be one of: ${validStrategies.join(', ')}`);
      }
    }

    // Wallets
    if (schema.trackWallets !== undefined) {
      if (Array.isArray(schema.trackWallets)) {
        const wallets: WalletConfig[] = [];

        for (let i = 0; i < schema.trackWallets.length; i++) {
          const w = schema.trackWallets[i];

          if (!w.address || typeof w.address !== 'string') {
            errors.push(`trackWallets[${i}]: address is required and must be a string`);
            continue;
          }

          if (!w.alias || typeof w.alias !== 'string') {
            errors.push(`trackWallets[${i}]: alias is required and must be a string`);
            continue;
          }

          const wallet: WalletConfig = {
            address: w.address.toLowerCase(),
            alias: w.alias,
            enabled: w.enabled !== false, // Default to true
          };

          if (w.allocation !== undefined) {
            if (typeof w.allocation === 'number' && w.allocation >= 0 && w.allocation <= 100) {
              wallet.allocation = w.allocation;
            } else {
              errors.push(`trackWallets[${i}]: allocation must be between 0 and 100`);
            }
          }

          wallets.push(wallet);
        }

        if (wallets.length > 0) {
          config.wallets = wallets;
        }
      } else {
        errors.push('trackWallets must be an array');
      }
    }

    return config;
  }

  /**
   * Get the current loaded config from file
   */
  getCurrentConfig(): ConfigFileSchema | null {
    return this.currentConfig;
  }

  /**
   * Start watching config file for changes
   */
  startWatching(): void {
    if (this.watcher) {
      return;
    }

    // Ensure data directory exists
    const dataDir = path.dirname(CONFIG_FILE_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Watch the data directory for config.json changes
    try {
      this.watcher = fs.watch(dataDir, (eventType, filename) => {
        if (filename === 'config.json') {
          // Debounce rapid file changes
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
          }

          this.debounceTimer = setTimeout(() => {
            this.handleConfigChange();
          }, 500);
        }
      });

      console.log('[ConfigLoader] Watching for config changes');
    } catch (err: any) {
      console.error('[ConfigLoader] Failed to start file watcher:', err.message);
    }
  }

  /**
   * Handle config file change
   */
  private handleConfigChange(): void {
    console.log('\n[ConfigLoader] Config file changed, reloading...');

    const result = this.loadFromFile();

    if (result.errors.length > 0) {
      console.error('[ConfigLoader] Config validation errors:');
      result.errors.forEach(e => console.error(`  - ${e}`));
      console.log('[ConfigLoader] Keeping previous config due to errors');
      return;
    }

    if (result.source === 'file') {
      console.log('[ConfigLoader] Config reloaded successfully');

      // Emit reload event with the new config
      this.emit('configReload', result.config);
    }
  }

  /**
   * Stop watching config file
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Force reload config from file
   */
  reload(): ConfigLoadResult {
    const result = this.loadFromFile();

    if (result.source === 'file' && result.errors.length === 0) {
      this.emit('configReload', result.config);
    }

    return result;
  }

  /**
   * Check which settings have changed between old and new config
   */
  getChangedSettings(oldConfig: Partial<CopyConfig>, newConfig: Partial<CopyConfig>): {
    hotReloadable: string[];
    requiresRestart: string[];
  } {
    const hotReloadable: string[] = [];
    const requiresRestart: string[] = [];

    const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

    for (const key of allKeys) {
      const oldVal = JSON.stringify((oldConfig as any)[key]);
      const newVal = JSON.stringify((newConfig as any)[key]);

      if (oldVal !== newVal) {
        if ((HOT_RELOADABLE_SETTINGS as readonly string[]).includes(key)) {
          hotReloadable.push(key);
        } else if ((RESTART_REQUIRED_SETTINGS as readonly string[]).includes(key)) {
          requiresRestart.push(key);
        }
      }
    }

    return { hotReloadable, requiresRestart };
  }
}

// Singleton instance
let configLoaderInstance: ConfigLoader | null = null;

/**
 * Get the singleton ConfigLoader instance
 */
export function getConfigLoader(): ConfigLoader {
  if (!configLoaderInstance) {
    configLoaderInstance = new ConfigLoader();
  }
  return configLoaderInstance;
}

/**
 * Log which settings came from file vs env
 */
export function logConfigSources(fileConfig: Partial<CopyConfig>, envOverrides: string[]): void {
  const fileSettings = Object.keys(fileConfig).filter(k => (fileConfig as any)[k] !== undefined);

  if (fileSettings.length > 0) {
    console.log('[Config] Settings from config.json:');
    fileSettings.forEach(s => console.log(`  - ${s}`));
  }

  if (envOverrides.length > 0) {
    console.log('[Config] Settings from .env (overridden by file):');
    envOverrides.forEach(s => console.log(`  - ${s}`));
  }
}
