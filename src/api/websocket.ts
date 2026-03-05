import WebSocket from 'ws';
import { EventEmitter } from 'events';

const MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export interface BookUpdate {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  hash: string;
}

export interface PriceChange {
  event_type: 'price_change';
  asset_id: string;
  market: string;
  price: string;
  side: string;
  timestamp: string;
}

export interface LastTradePrice {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string;
  price: string;
  timestamp: string;
}

export type MarketEvent = BookUpdate | PriceChange | LastTradePrice;

export class MarketWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedAssets: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private hasConnectedOnce = false;

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(MARKET_WS_URL);

      this.ws.on('open', () => {
        // Only log first connection, silent reconnects
        if (!this.hasConnectedOnce) {
          console.log('[WS] Connected to Polymarket market WebSocket');
          this.hasConnectedOnce = true;
        }
        this.isConnecting = false;
        this.startPingInterval();

        // Resubscribe to assets if reconnecting
        if (this.subscribedAssets.size > 0) {
          this.subscribeToAssets(Array.from(this.subscribedAssets));
        }

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message === 'PONG') {
            return;
          }

          if (Array.isArray(message)) {
            for (const event of message) {
              this.handleEvent(event);
            }
          } else {
            this.handleEvent(message);
          }
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('[WS] WebSocket error:', error);
        this.isConnecting = false;
        reject(error);
      });

      this.ws.on('close', (code) => {
        this.isConnecting = false;
        this.stopPingInterval();

        // Only log unexpected closes (not normal idle timeout)
        if (code !== 1000 && code !== 1001) {
          console.log(`[WS] Connection closed (code: ${code})`);
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleEvent(event: MarketEvent): void {
    switch (event.event_type) {
      case 'book':
        this.emit('book', event as BookUpdate);
        break;
      case 'price_change':
        this.emit('price_change', event as PriceChange);
        break;
      case 'last_trade_price':
        this.emit('last_trade_price', event as LastTradePrice);
        break;
      default:
        this.emit('unknown', event);
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, 9000); // Send ping every 9 seconds (before 10s timeout)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Silent reconnect - don't spam logs
    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(console.error);
    }, 5000);
  }

  subscribeToAssets(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Store for later subscription
      assetIds.forEach(id => this.subscribedAssets.add(id));
      return;
    }

    const message = {
      assets_ids: assetIds,
      type: 'market',
      custom_feature_enabled: true,
    };

    this.ws.send(JSON.stringify(message));
    assetIds.forEach(id => this.subscribedAssets.add(id));
    console.log(`[WS] Subscribed to ${assetIds.length} assets`);
  }

  unsubscribeFromAssets(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      assetIds.forEach(id => this.subscribedAssets.delete(id));
      return;
    }

    const message = {
      assets_ids: assetIds,
      operation: 'unsubscribe',
    };

    this.ws.send(JSON.stringify(message));
    assetIds.forEach(id => this.subscribedAssets.delete(id));
    console.log(`[WS] Unsubscribed from ${assetIds.length} assets`);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscribedAssets.clear();
    console.log('[WS] Disconnected');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
