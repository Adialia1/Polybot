import axios, { AxiosInstance } from 'axios';
import { Market } from '../types/index.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

export class GammaApiClient {
  private client: AxiosInstance;
  private marketCache: Map<string, { market: Market; cachedAt: number }> = new Map();
  private cacheTtl = 30000; // 30 seconds cache

  constructor() {
    this.client = axios.create({
      baseURL: GAMMA_API_BASE,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async getMarket(conditionId: string): Promise<Market | null> {
    const cached = this.marketCache.get(conditionId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.market;
    }

    try {
      const response = await this.client.get<Market[]>('/markets', {
        params: { condition_id: conditionId },
      });

      if (response.data.length > 0) {
        const market = response.data[0];
        this.marketCache.set(conditionId, { market, cachedAt: Date.now() });
        return market;
      }

      return null;
    } catch (error) {
      console.error(`Failed to fetch market ${conditionId}:`, error);
      return null;
    }
  }

  async getMarketBySlug(slug: string): Promise<Market | null> {
    try {
      const response = await this.client.get<Market[]>('/markets', {
        params: { slug },
      });

      if (response.data.length > 0) {
        return response.data[0];
      }

      return null;
    } catch (error) {
      console.error(`Failed to fetch market by slug ${slug}:`, error);
      return null;
    }
  }

  async searchMarkets(query: string): Promise<Market[]> {
    try {
      const response = await this.client.get<Market[]>('/markets', {
        params: { _q: query, active: true },
      });
      return response.data;
    } catch (error) {
      console.error(`Failed to search markets:`, error);
      return [];
    }
  }

  clearCache(): void {
    this.marketCache.clear();
  }
}
