import axios, { AxiosInstance } from 'axios';
import { Trade, Position } from '../types/index.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

export class DataApiClient {
  private client: AxiosInstance;
  private requestDelay = 100; // 100ms between requests to respect rate limits

  constructor() {
    this.client = axios.create({
      baseURL: DATA_API_BASE,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getTrades(
    walletAddress: string,
    options: {
      limit?: number;
      offset?: number;
      side?: 'BUY' | 'SELL';
    } = {}
  ): Promise<Trade[]> {
    const { limit = 100, offset = 0, side } = options;

    const params: Record<string, string | number> = {
      user: walletAddress,
      limit,
      offset,
    };

    if (side) {
      params.side = side;
    }

    const response = await this.client.get<Trade[]>('/trades', { params });
    await this.delay(this.requestDelay);
    return response.data;
  }

  async getAllRecentTrades(
    walletAddress: string,
    sinceTimestamp?: number
  ): Promise<Trade[]> {
    const allTrades: Trade[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const trades = await this.getTrades(walletAddress, { limit, offset });

      if (trades.length === 0) {
        hasMore = false;
        break;
      }

      for (const trade of trades) {
        if (sinceTimestamp && trade.timestamp < sinceTimestamp) {
          hasMore = false;
          break;
        }
        allTrades.push(trade);
      }

      if (trades.length < limit) {
        hasMore = false;
      }

      offset += limit;
    }

    return allTrades;
  }

  async getPositions(
    walletAddress: string,
    options: {
      limit?: number;
      offset?: number;
      sizeThreshold?: number;
    } = {}
  ): Promise<Position[]> {
    const { limit = 100, offset = 0, sizeThreshold = 0 } = options;

    const params = {
      user: walletAddress,
      limit,
      offset,
      sizeThreshold,
    };

    const response = await this.client.get<Position[]>('/positions', { params });
    await this.delay(this.requestDelay);
    return response.data;
  }

  async getAllPositions(walletAddress: string): Promise<Position[]> {
    const allPositions: Position[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const positions = await this.getPositions(walletAddress, { limit, offset });

      if (positions.length === 0) {
        hasMore = false;
        break;
      }

      allPositions.push(...positions);

      if (positions.length < limit) {
        hasMore = false;
      }

      offset += limit;
    }

    return allPositions;
  }

  async getActivity(
    walletAddress: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Trade[]> {
    const { limit = 100, offset = 0 } = options;

    const params = {
      user: walletAddress,
      limit,
      offset,
    };

    const response = await this.client.get<any[]>('/activity', { params });
    await this.delay(this.requestDelay);

    // Filter to only TRADE type and map to Trade interface
    return response.data
      .filter(item => item.type === 'TRADE')
      .map(item => ({
        id: item.transactionHash,
        proxyWallet: item.proxyWallet,
        side: item.side as 'BUY' | 'SELL',
        asset: item.asset,
        conditionId: item.conditionId,
        size: String(item.size),
        price: String(item.price),
        timestamp: item.timestamp,
        title: item.title,
        slug: item.slug,
        outcome: item.outcome,
        outcomeIndex: item.outcomeIndex,
        transactionHash: item.transactionHash,
        eventSlug: item.eventSlug,
      }));
  }
}
