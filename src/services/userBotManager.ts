import { TradeMonitor } from './tradeMonitor.js';
import { PositionSizer } from './positionSizer.js';
import { OrderQueue, QueuedOrder } from './orderQueue.js';
import { RiskManager } from './riskManager.js';
import { Trader, TradeResult } from './trader.js';
import { ClobApiClient } from '../api/clobApi.js';
import { isMarketBlacklisted, isMarketWhitelisted } from './tradeFilter.js';
import { UserDb, UserSettings } from '../db/userDb.js';
import { TradeSignal, WalletConfig, CopyConfig } from '../types/index.js';
import TelegramBot from 'node-telegram-bot-api';

export interface UserBotInstance {
  chatId: string;
  monitor: TradeMonitor | null;
  trader: Trader | null;
  orderQueue: OrderQueue;
  positionSizer: PositionSizer;
  isRunning: boolean;
}

export class UserBotManager {
  private userBots = new Map<string, UserBotInstance>();
  private db: UserDb;
  private telegramBot: TelegramBot;

  constructor(db: UserDb, telegramBot: TelegramBot) {
    this.db = db;
    this.telegramBot = telegramBot;
  }

  isUserRunning(chatId: string): boolean {
    return this.userBots.get(chatId)?.isRunning || false;
  }

  getUserBot(chatId: string): UserBotInstance | undefined {
    return this.userBots.get(chatId);
  }

  async startUserBot(chatId: string): Promise<void> {
    if (this.userBots.get(chatId)?.isRunning) {
      throw new Error('Already running');
    }

    const settings = this.db.getSettings(chatId);
    const wallets = this.db.getWallets(chatId);
    const trackedWallets = this.db.getTrackedWallets(chatId).filter(t => t.enabled);

    if (wallets.length === 0) throw new Error('No wallet connected');
    if (trackedWallets.length === 0) throw new Error('No traders to follow');

    const defaultWallet = this.db.getDefaultWallet(chatId) || wallets[0];
    const privateKey = this.db.decryptPrivateKey(defaultWallet.encryptedPrivateKey);

    // Build wallet configs for TradeMonitor
    const walletConfigs: WalletConfig[] = trackedWallets.map(tw => ({
      address: tw.walletAddress,
      alias: tw.alias,
      enabled: true,
      allocation: tw.allocation,
    }));

    // Create position sizer
    const positionSizer = new PositionSizer({
      userAccountSize: settings.userAccountSize,
      maxPositionSize: settings.maxPositionSize,
      minTradeSize: settings.minTradeSize,
      maxPercentage: settings.maxPercentagePerTrade,
    });

    // Create order queue
    const orderQueue = new OrderQueue({
      maxConcurrent: 3,
      orderDelayMs: 200,
    });

    // Create trader
    const trader = new Trader({
      privateKey,
      funderAddress: defaultWallet.funderAddress || undefined,
      dryRun: settings.dryRun,
      signatureType: defaultWallet.signatureType,
      orderSlippagePercent: settings.orderSlippagePercent,
      maxBuyPrice: settings.maxProbability,
    });

    await trader.initialize();

    // Create trade monitor
    const monitor = new TradeMonitor({
      wallets: walletConfigs,
      pollingIntervalMs: 1000,
    });

    const instance: UserBotInstance = {
      chatId,
      monitor,
      trader,
      orderQueue,
      positionSizer,
      isRunning: true,
    };

    // Handle trade signals
    monitor.on('trade', async (signal: TradeSignal) => {
      await this.handleTradeSignal(chatId, instance, signal, settings);
    });

    // Handle order processing
    orderQueue.on('process', async (order: QueuedOrder) => {
      await this.executeOrder(chatId, instance, order);
    });

    this.userBots.set(chatId, instance);

    // Start monitoring
    await monitor.start();

    // Load persisted state (last seen trades)
    const state = this.db.getUserState(chatId);
    if (state.lastSeenTrades) {
      for (const [addr, ts] of Object.entries(state.lastSeenTrades)) {
        (monitor as any).lastSeenTrades?.set(addr, ts);
      }
    }

    await this.sendNotification(chatId,
      `🟢 <b>Trading Started!</b>\n\n` +
      `Mode: ${settings.dryRun ? '🔶 Dry Run' : '🟢 LIVE'}\n` +
      `Following: ${trackedWallets.map(t => t.alias).join(', ')}\n` +
      `Max position: $${settings.maxPositionSize}`
    );
  }

  async stopUserBot(chatId: string): Promise<void> {
    const instance = this.userBots.get(chatId);
    if (!instance) return;

    instance.isRunning = false;

    if (instance.monitor) {
      instance.monitor.stop();
    }

    // Save state before stopping
    this.saveUserState(chatId, instance);

    this.userBots.delete(chatId);

    await this.sendNotification(chatId, '⏹ <b>Trading Stopped</b>');
  }

  async stopAll(): Promise<void> {
    for (const chatId of this.userBots.keys()) {
      await this.stopUserBot(chatId);
    }
  }

  private async handleTradeSignal(
    chatId: string,
    instance: UserBotInstance,
    signal: TradeSignal,
    settings: UserSettings
  ): Promise<void> {
    const trade = signal.trade;

    // Apply filters
    const blacklist = settings.blacklistKeywords ? settings.blacklistKeywords.split(',').map(k => k.trim()).filter(Boolean) : [];
    const whitelist = settings.whitelistKeywords ? settings.whitelistKeywords.split(',').map(k => k.trim()).filter(Boolean) : [];

    if (blacklist.length > 0 && isMarketBlacklisted(trade.title, blacklist)) {
      console.log(`[User ${chatId}] Skipping blacklisted market: ${trade.title}`);
      return;
    }

    if (whitelist.length > 0 && !isMarketWhitelisted(trade.title, whitelist)) {
      console.log(`[User ${chatId}] Skipping non-whitelisted market: ${trade.title}`);
      return;
    }

    // Probability filter
    const price = parseFloat(trade.price);
    if (price < settings.minProbability || price > settings.maxProbability) {
      console.log(`[User ${chatId}] Skipping: price ${price} outside range [${settings.minProbability}, ${settings.maxProbability}]`);
      return;
    }

    // Skip sells if copySells is disabled
    if (trade.side === 'SELL' && !settings.copySells) {
      console.log(`[User ${chatId}] Skipping sell (copySells disabled)`);
      return;
    }

    // Check max open positions
    const state = this.db.getUserState(chatId);
    const positions = state.positions || {};
    if (settings.maxOpenPositions > 0 && Object.keys(positions).length >= settings.maxOpenPositions) {
      console.log(`[User ${chatId}] Skipping: max open positions reached`);
      return;
    }

    // Calculate position size
    const trackedWallets = this.db.getTrackedWallets(chatId);
    const trackerWallet = trackedWallets.find(w => w.walletAddress === trade.proxyWallet);
    const allocation = trackerWallet?.allocation || 100;
    const tradeUsd = parseFloat(trade.size) * parseFloat(trade.price);
    const scaledAmount = Math.min(
      tradeUsd * (allocation / 100),
      settings.maxPositionSize,
      settings.userAccountSize * (settings.maxPercentagePerTrade / 100)
    );

    if (scaledAmount < settings.minTradeSize) {
      console.log(`[User ${chatId}] Skipping: scaled amount $${scaledAmount.toFixed(2)} below minimum`);
      return;
    }

    // Enqueue order
    instance.orderQueue.enqueue(
      trade,
      trackerWallet?.alias || 'Unknown',
      trade.proxyWallet,
      scaledAmount,
    );
  }

  private async executeOrder(chatId: string, instance: UserBotInstance, order: QueuedOrder): Promise<void> {
    if (!instance.trader) return;

    const trade = order.trade;
    const price = parseFloat(trade.price);

    try {
      let result: TradeResult;

      if (trade.side === 'BUY') {
        result = await instance.trader.copyTrade(trade, order.amount);
      } else {
        result = await instance.trader.sellPosition(
          trade.asset,
          parseFloat(trade.size),
          price,
          trade.title
        );
      }

      // Update state
      const state = this.db.getUserState(chatId);
      if (!state.positions) state.positions = {};
      if (!state.stats) state.stats = { totalTrades: 0, successfulTrades: 0, failedTrades: 0, totalVolume: 0, startTime: Date.now(), lastUpdateTime: Date.now() };
      if (!state.orders) state.orders = [];

      state.stats.totalTrades++;
      state.stats.lastUpdateTime = Date.now();

      if (result.success) {
        state.stats.successfulTrades++;
        state.stats.totalVolume += order.amount;

        if (trade.side === 'BUY') {
          state.positions[trade.asset] = {
            asset: trade.asset,
            size: order.amount / price,
            avgPrice: price,
            title: trade.title,
            outcome: trade.outcome,
            slug: trade.slug,
            entryTime: Date.now(),
            walletAlias: order.walletAlias,
            conditionId: trade.conditionId,
          };
        } else {
          delete state.positions[trade.asset];
        }

        // Notify success
        const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
        await this.sendNotification(chatId,
          `${emoji} <b>Trade Executed</b>\n\n` +
          `<b>Side:</b> ${trade.side}\n` +
          `<b>Market:</b> ${trade.title}\n` +
          `<b>Outcome:</b> ${trade.outcome}\n` +
          `<b>Amount:</b> $${order.amount.toFixed(2)}\n` +
          `<b>Price:</b> ${(price * 100).toFixed(1)}%\n` +
          `<b>Copied from:</b> ${order.walletAlias}`
        );
      } else {
        state.stats.failedTrades++;
        await this.sendNotification(chatId,
          `❌ <b>Trade Failed</b>\n\n` +
          `<b>Side:</b> ${trade.side}\n` +
          `<b>Market:</b> ${trade.title}\n` +
          `<b>Error:</b> ${result.error}`
        );
      }

      // Keep last 100 orders
      state.orders.unshift({
        id: order.id,
        asset: trade.asset,
        side: trade.side,
        amount: order.amount,
        status: result.success ? 'filled' : 'failed',
        createdAt: Date.now(),
        walletAlias: order.walletAlias,
      });
      if (state.orders.length > 100) state.orders = state.orders.slice(0, 100);

      this.db.saveUserState(chatId, state);
    } catch (error: any) {
      console.error(`[User ${chatId}] Order execution error:`, error.message);
      await this.sendNotification(chatId, `❌ Order error: ${error.message}`);
    }
  }

  private saveUserState(chatId: string, instance: UserBotInstance): void {
    try {
      const state = this.db.getUserState(chatId);
      // Save last seen trade timestamps
      if (instance.monitor) {
        const lastSeen: Record<string, number> = {};
        const monitorMap = (instance.monitor as any).lastSeenTrades;
        if (monitorMap) {
          for (const [addr, ts] of monitorMap.entries()) {
            lastSeen[addr] = ts as number;
          }
        }
        state.lastSeenTrades = lastSeen;
      }
      this.db.saveUserState(chatId, state);
    } catch (error: any) {
      console.error(`[User ${chatId}] Failed to save state:`, error.message);
    }
  }

  private async sendNotification(chatId: string, message: string): Promise<void> {
    try {
      await this.telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error: any) {
      console.error(`[User ${chatId}] Failed to send notification:`, error.message);
    }
  }
}
