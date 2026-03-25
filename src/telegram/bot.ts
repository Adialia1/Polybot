import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../db/userDb.js';
import { UserBotManager } from '../services/userBotManager.js';
import { registerStartHandler } from './handlers/start.js';
import { registerWalletHandler } from './handlers/wallet.js';
import { registerFollowHandler } from './handlers/follow.js';
import { registerSettingsHandler } from './handlers/settings.js';
import { registerPositionsHandler } from './handlers/positions.js';
import { registerStatsHandler } from './handlers/stats.js';
import { registerTradingHandler } from './handlers/trading.js';
import { registerHelpHandler } from './handlers/help.js';

export class TelegramTradingBot {
  private bot: TelegramBot;
  private db: UserDb;
  private botManager: UserBotManager;

  constructor(token: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.db = new UserDb();
    this.botManager = new UserBotManager(this.db, this.bot);

    this.registerHandlers();
    this.setupErrorHandling();
  }

  private registerHandlers(): void {
    const getBotManager = () => this.botManager;

    registerStartHandler(this.bot, this.db);
    registerWalletHandler(this.bot, this.db);
    registerFollowHandler(this.bot, this.db);
    registerSettingsHandler(this.bot, this.db);
    registerPositionsHandler(this.bot, this.db, getBotManager);
    registerStatsHandler(this.bot, this.db);
    registerTradingHandler(this.bot, this.db, getBotManager);
    registerHelpHandler(this.bot);
  }

  private setupErrorHandling(): void {
    this.bot.on('polling_error', (error) => {
      console.error('[TelegramBot] Polling error:', error.message);
    });

    this.bot.on('error', (error) => {
      console.error('[TelegramBot] Error:', error.message);
    });
  }

  async stop(): Promise<void> {
    console.log('[TelegramBot] Stopping...');
    await this.botManager.stopAll();
    await this.bot.stopPolling();
    this.db.close();
    console.log('[TelegramBot] Stopped');
  }

  getDb(): UserDb {
    return this.db;
  }

  getBotManager(): UserBotManager {
    return this.botManager;
  }
}
