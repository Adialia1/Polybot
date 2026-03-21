export interface Trade {
  id: string;
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: string;
  price: string;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  eventSlug: string;
}

export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  totalBought: string;
  realizedPnl: string;
  curPrice: string;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}

export interface Market {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  active: boolean;
  closed: boolean;
  tokens: MarketToken[];
}

export interface MarketToken {
  token_id: string;
  outcome: string;
  price: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface TradeSignal {
  type: 'NEW_TRADE';
  trade: Trade;
  detectedAt: number;
}

export interface WalletConfig {
  address: string;
  alias: string;
  enabled: boolean;
  allocation?: number; // 0-100, percentage of position size to use for this trader (default: 100)
}

// Conflict resolution strategy when tracked traders make opposite trades
export type ConflictStrategy = 'first' | 'skip' | 'majority' | 'highest_allocation';

// Recent trade signal for conflict detection
export interface RecentSignal {
  market: string;       // Market slug or conditionId
  side: 'BUY' | 'SELL';
  outcome: string;      // e.g., "Yes" or "No"
  walletAlias: string;
  walletAddress: string;
  allocation: number;   // Trader's allocation percentage
  timestamp: number;
}

export interface CopyConfig {
  wallets: WalletConfig[];
  pollingIntervalMs: number;
  copyDelayMs: number;
  maxPositionSize: number;
  minTradeSize: number;
  userAccountSize: number;
  maxPercentagePerTrade: number;
  // Probability filters (price = probability on Polymarket)
  minProbability: number; // Skip trades below this (e.g., 0.05 = 5%)
  maxProbability: number; // Skip trades above this (e.g., 0.95 = 95%)
  // Market blacklist
  blacklistKeywords: string[]; // Keywords to block (e.g., ["NBA", "NFL", "soccer"])
  // Market whitelist
  whitelistKeywords: string[]; // Keywords to allow (e.g., ["Bitcoin", "Trump", "Election"]) - if empty, all markets allowed
  // Position limits
  maxOpenPositions: number; // Max number of open positions (0 = unlimited)
  // Trading settings
  enableTrading: boolean; // Enable actual trade execution
  dryRun: boolean; // If true, simulate trades without executing
  privateKey?: string; // Polygon wallet private key
  funderAddress?: string; // Proxy wallet address (if using Magic/email wallet)
  // Retry settings
  maxRetries: number; // Max retry attempts for failed orders (default: 3)
  retryDelayMs: number; // Base delay between retries in ms (default: 2000)
  // Daily loss limit
  dailyLossLimit: number; // Max daily loss in USD (e.g., 10 = stop if down $10, 0 = disabled)
  // Stop loss / Take profit
  stopLossPercent: number; // Sell if position drops X% (negative, e.g., -25 = sell at 25% loss)
  takeProfitPercent: number; // Sell if position gains X% (e.g., 100 = sell at 100% gain)
  // Trailing stop loss
  trailingStopPercent: number; // Sell if price drops X% from peak (0 = disabled)
  trailingStopCheckIntervalMs: number; // Check interval in ms
  // Health check server
  healthCheckEnabled: boolean; // Enable HTTP health check server
  healthCheckPort: number; // Port for health check server (default: 3000)
  // Conflict resolution
  conflictStrategy: ConflictStrategy; // Strategy when traders make opposite trades
  // Buy-only mode
  copySells: boolean; // If false, ignore sell signals from tracked traders (default: true)
  // Time-based exit
  maxHoldTimeHours: number; // Auto-sell positions held longer than this (0 = disabled)
  // Web Dashboard
  dashboardEnabled: boolean; // Enable web dashboard server
  dashboardPort: number; // Port for web dashboard (default: 8080)
  // Trade filters (configurable via config.json)
  maxPriceDiffPercent?: number; // Skip if price moved >X% unfavorably (default: 5)
  orderSlippagePercent?: number; // Slippage tolerance for market orders (default: 15)
  minTraderTradeUsd?: number; // Skip trader trades below $X (filters hedge legs, default: 0)
  signatureType?: number; // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
  maxPositionValue?: number; // Max total $ spent per market (0 = unlimited)
  addOnSize?: number; // Max $ per add-on trade to existing position
  telegramBotToken?: string; // Telegram bot token
  telegramChatId?: string; // Telegram chat ID
}
