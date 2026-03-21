import axios, { AxiosInstance } from 'axios';
import { OrderBook } from '../types/index.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';

export interface PriceResponse {
  price: string;
}

export interface MidpointResponse {
  mid: string;
}

export class ClobApiClient {
  private client: AxiosInstance;
  private priceCache: Map<string, { price: string; cachedAt: number }> = new Map();
  private cacheTtl = 5000; // 5 seconds cache for prices

  constructor() {
    this.client = axios.create({
      baseURL: CLOB_API_BASE,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const response = await this.client.get<OrderBook>('/book', {
      params: { token_id: tokenId },
    });
    return response.data;
  }

  /**
   * Safe version — returns null instead of throwing on 404 / "No orderbook exists".
   */
  async getOrderBookSafe(tokenId: string): Promise<OrderBook | null> {
    try {
      return await this.getOrderBook(tokenId);
    } catch (error: any) {
      const status = error?.response?.status;
      const msg = error?.response?.data?.error || error?.message || '';
      if (status === 404 || msg.includes('No orderbook exists')) {
        return null;
      }
      throw error; // re-throw unexpected errors
    }
  }

  async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<string> {
    const cacheKey = `${tokenId}-${side}`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.price;
    }

    const response = await this.client.get<PriceResponse>('/price', {
      params: { token_id: tokenId, side },
    });

    this.priceCache.set(cacheKey, {
      price: response.data.price,
      cachedAt: Date.now(),
    });

    return response.data.price;
  }

  async getMidpoint(tokenId: string): Promise<string> {
    const cacheKey = `${tokenId}-mid`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.price;
    }

    const response = await this.client.get<MidpointResponse>('/midpoint', {
      params: { token_id: tokenId },
    });

    this.priceCache.set(cacheKey, {
      price: response.data.mid,
      cachedAt: Date.now(),
    });

    return response.data.mid;
  }

  async getSpread(tokenId: string): Promise<{ bid: string; ask: string; spread: string }> {
    const book = await this.getOrderBook(tokenId);

    const bestBid = book.bids.length > 0 ? book.bids[0].price : '0';
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : '1';

    const spread = (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(4);

    return { bid: bestBid, ask: bestAsk, spread };
  }

  /**
   * Safe version — returns { bid: '0', ask: '1', spread: '1.0000' } on 404 / missing orderbook.
   */
  async getSpreadSafe(tokenId: string): Promise<{ bid: string; ask: string; spread: string }> {
    const book = await this.getOrderBookSafe(tokenId);
    if (!book) {
      return { bid: '0', ask: '1', spread: '1.0000' };
    }

    const bestBid = book.bids.length > 0 ? book.bids[0].price : '0';
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : '1';
    const spread = (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(4);

    return { bid: bestBid, ask: bestAsk, spread };
  }

  /**
   * Get market info including resolution status.
   * Returns { closed, tokens: [{ token_id, outcome, winner }], neg_risk }
   */
  async getMarket(conditionId: string): Promise<any> {
    const response = await this.client.get(`/markets/${conditionId}`);
    return response.data;
  }

  clearCache(): void {
    this.priceCache.clear();
  }
}
