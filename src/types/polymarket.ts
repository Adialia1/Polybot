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
}

export interface CopyConfig {
  wallets: WalletConfig[];
  pollingIntervalMs: number;
  copyDelayMs: number;
  maxPositionSize: number;
  minTradeSize: number;
}
