import TelegramBot from 'node-telegram-bot-api';
import { StateManager } from './stateManager.js';
import type { Redeemer } from './redeemer.js';

export interface TradeNotification {
  side: 'BUY' | 'SELL';
  title: string;
  outcome: string;
  amount: number;
  price: number;
  size?: number;
  orderId?: string;
  walletAlias?: string;
}

export interface TradeFailedNotification {
  side: 'BUY' | 'SELL';
  title: string;
  outcome: string;
  amount: number;
  error: string;
  walletAlias?: string;
}

export interface RiskTriggerNotification {
  type: 'STOP_LOSS' | 'TAKE_PROFIT';
  title: string;
  outcome: string;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  size: number;
  success: boolean;
  orderId?: string;
  error?: string;
}

export interface DailySummary {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  positions: {
    title: string;
    outcome: string;
    size: number;
    avgPrice: number;
    currentPrice?: number;
    pnlPercent?: number;
  }[];
}

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private enabled: boolean = false;
  private stateManager: StateManager | null = null;
  private redeemer: Redeemer | null = null;
  private onStopCallback: (() => void) | null = null;
  private startTime: number = Date.now();

  constructor(stateManager?: StateManager) {
    // Read from config.json first, fall back to env
    let cfgToken: string | undefined;
    let cfgChatId: string | undefined;
    try {
      const { readFileSync, existsSync } = require('fs');
      const configPath = './data/config.json';
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        cfgToken = cfg.telegramBotToken;
        cfgChatId = cfg.telegramChatId;
      }
    } catch { /* ignore */ }
    const token = cfgToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = cfgChatId || process.env.TELEGRAM_CHAT_ID;

    if (stateManager) {
      this.stateManager = stateManager;
    }

    if (token && chatId) {
      try {
        this.bot = new TelegramBot(token, { polling: true });
        this.chatId = chatId;
        this.enabled = true;
        this.setupCommands();
        console.log('[Notifier] Telegram notifications enabled with command support');
      } catch (error) {
        console.warn('[Notifier] Failed to initialize Telegram bot:', error);
        this.enabled = false;
      }
    } else {
      console.log('[Notifier] Telegram notifications disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    }
  }

  /**
   * Set the redeemer instance (called after bot initialization)
   */
  setRedeemer(redeemer: Redeemer): void {
    this.redeemer = redeemer;
  }

  setOnStop(callback: () => void): void {
    this.onStopCallback = callback;
  }

  /**
   * Setup command handlers
   */
  private setupCommands(): void {
    if (!this.bot) return;

    // /status - Check if bot is active
    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;

      const message = `
✅ <b>Bot Status: ACTIVE</b>

<b>Uptime:</b> ${hours}h ${minutes}m ${seconds}s
<b>Started:</b> ${new Date(this.startTime).toLocaleString()}
      `.trim();

      await this.sendMessage(message);
    });

    // /positions - Show current positions
    this.bot.onText(/\/positions/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId || !this.stateManager) return;

      const positions = this.stateManager.getAllPositions();

      if (positions.length === 0) {
        await this.sendMessage('📊 <b>No open positions</b>');
        return;
      }

      let message = '📊 <b>Open Positions</b>\n\n';
      positions.forEach((pos, i) => {
        message += `${i + 1}. <b>${pos.outcome}</b>\n`;
        message += `   Market: ${pos.title}\n`;
        message += `   Size: ${pos.size.toFixed(4)} shares @ $${pos.avgPrice.toFixed(3)}\n`;
        message += `   Value: $${(pos.size * pos.avgPrice).toFixed(2)}\n\n`;
      });

      await this.sendMessage(message);
    });

    // /stats - Show trading statistics
    this.bot.onText(/\/stats/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId || !this.stateManager) return;

      const stats = this.stateManager.getStats();
      const successRate = stats.totalTrades > 0
        ? ((stats.successfulTrades / stats.totalTrades) * 100).toFixed(1)
        : '0.0';

      const message = `
📈 <b>Trading Statistics</b>

<b>Total Trades:</b> ${stats.totalTrades}
<b>Successful:</b> ${stats.successfulTrades}
<b>Failed:</b> ${stats.failedTrades}
<b>Success Rate:</b> ${successRate}%
<b>Total Volume:</b> $${stats.totalVolume.toFixed(2)}
      `.trim();

      await this.sendMessage(message);
    });

    // /redeem - Redeem all resolved winning positions
    this.bot.onText(/\/redeem/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      if (!this.redeemer) {
        await this.sendMessage('❌ Redeemer not initialized');
        return;
      }

      await this.sendMessage('🔄 Checking for redeemable positions...');

      try {
        const summary = await this.redeemer.getRedeemableSummary();

        if (summary.count === 0) {
          await this.sendMessage('✅ No redeemable positions found');
          return;
        }

        await this.sendMessage(`Found ${summary.count} redeemable position(s) worth ~$${summary.totalValue.toFixed(2)}. Redeeming...`);

        const results = await this.redeemer.redeemAll();
        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        let resultMsg = `💰 <b>Redemption Complete</b>\n\n`;
        resultMsg += `✅ Redeemed: ${succeeded.length}\n`;
        if (failed.length > 0) resultMsg += `❌ Failed: ${failed.length}\n`;

        for (const r of succeeded) {
          resultMsg += `\n• ${r.title.slice(0, 35)}`;
          if (r.txHash) resultMsg += ` — <a href="https://polygonscan.com/tx/${r.txHash}">tx</a>`;
        }
        for (const r of failed) {
          resultMsg += `\n• ❌ ${r.title.slice(0, 35)} — ${r.error?.slice(0, 50)}`;
        }

        await this.sendMessage(resultMsg);
      } catch (err: any) {
        await this.sendMessage(`❌ Redeem error: ${err?.message?.slice(0, 100)}`);
      }
    });

    // /balance - Show USDC balance and redeemable positions
    this.bot.onText(/\/balance/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      let message = '💰 <b>Account Balance</b>\n\n';

      if (this.redeemer) {
        try {
          const summary = await this.redeemer.getRedeemableSummary();
          if (summary.count > 0) {
            message += `🎯 <b>Redeemable: ${summary.count} position(s) ≈ $${summary.totalValue.toFixed(2)}</b>\n`;
            for (const label of summary.positions.slice(0, 10)) {
              message += `  • ${label}\n`;
            }
            message += `\nUse /redeem to claim them!\n`;
          } else {
            message += '✅ No pending redemptions\n';
          }
        } catch {
          message += '⚠️ Could not check redeemable positions\n';
        }
      }

      if (this.stateManager) {
        const positions = this.stateManager.getAllPositions();
        const totalValue = positions.reduce((sum, p) => sum + (p.size * p.avgPrice), 0);
        message += `\n📊 Open positions: ${positions.length} (cost: $${totalValue.toFixed(2)})`;
      }

      await this.sendMessage(message);
    });

    // /stop - Stop the bot gracefully
    this.bot.onText(/\/stop/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      await this.sendMessage('🛑 <b>Stopping bot...</b>\nThe auto-deploy script will restart it if running.');

      if (this.onStopCallback) {
        setTimeout(() => {
          this.onStopCallback!();
          process.exit(0);
        }, 1000);
      } else {
        setTimeout(() => process.exit(0), 1000);
      }
    });

    // /help - Show available commands
    this.bot.onText(/\/help/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      const message = `
🤖 <b>Available Commands</b>

/status - Check if bot is active
/positions - Show open positions
/stats - Show trading statistics
/balance - Show balance & redeemable positions
/redeem - Redeem all resolved winning positions
/stop - Stop the bot (auto-deploy will restart)
/help - Show this help message
      `.trim();

      await this.sendMessage(message);
    });
  }

  /**
   * Stop polling (cleanup)
   */
  async stopPolling(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      console.log('[Notifier] Telegram polling stopped');
    }
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a custom notification message (public, for auto-redeem etc.)
   */
  async notifyCustom(text: string): Promise<void> {
    await this.sendMessage(text);
  }

  /**
   * Send a raw message (internal use)
   */
  private async sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: parseMode });
      console.log('[Notifier] Telegram notification sent');
    } catch (error: any) {
      console.error('[Notifier] Failed to send Telegram notification:', error?.message || error);
      // Don't throw - notifications should never crash the bot
    }
  }

  /**
   * Notify when a trade is successfully executed
   */
  async notifyTradeExecuted(trade: TradeNotification): Promise<void> {
    const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
    const message = `
${emoji} <b>Trade Executed</b>

<b>Side:</b> ${trade.side}
<b>Market:</b> ${trade.title}
<b>Outcome:</b> ${trade.outcome}
<b>Amount:</b> $${trade.amount.toFixed(2)}
<b>Price:</b> $${trade.price.toFixed(3)} (${(trade.price * 100).toFixed(1)}%)
${trade.size ? `<b>Size:</b> ${trade.size.toFixed(4)} shares` : ''}
${trade.walletAlias ? `<b>Copied from:</b> ${trade.walletAlias}` : ''}
${trade.orderId ? `<b>Order ID:</b> <code>${trade.orderId}</code>` : ''}
`.trim();

    await this.sendMessage(message);
  }

  /**
   * Notify when a trade fails
   */
  async notifyTradeFailed(trade: TradeFailedNotification): Promise<void> {
    const message = `
❌ <b>Trade Failed</b>

<b>Side:</b> ${trade.side}
<b>Market:</b> ${trade.title}
<b>Outcome:</b> ${trade.outcome}
<b>Amount:</b> $${trade.amount.toFixed(2)}
${trade.walletAlias ? `<b>Copied from:</b> ${trade.walletAlias}` : ''}
<b>Error:</b> ${trade.error}
`.trim();

    await this.sendMessage(message);
  }

  /**
   * Notify when stop loss or take profit is triggered
   */
  async notifyRiskTrigger(trigger: RiskTriggerNotification): Promise<void> {
    const emoji = trigger.type === 'STOP_LOSS' ? '⚠️' : '🎯';
    const typeLabel = trigger.type === 'STOP_LOSS' ? 'Stop Loss' : 'Take Profit';
    const pnlSign = trigger.pnlPercent >= 0 ? '+' : '';

    const statusLine = trigger.success
      ? `✅ Position sold successfully${trigger.orderId ? ` (Order: <code>${trigger.orderId}</code>)` : ''}`
      : `❌ Failed to sell: ${trigger.error}`;

    const message = `
${emoji} <b>${typeLabel} Triggered</b>

<b>Market:</b> ${trigger.title}
<b>Outcome:</b> ${trigger.outcome}
<b>Entry Price:</b> $${trigger.entryPrice.toFixed(3)}
<b>Current Price:</b> $${trigger.currentPrice.toFixed(3)}
<b>P&L:</b> ${pnlSign}${trigger.pnlPercent.toFixed(1)}%
<b>Size:</b> ${trigger.size.toFixed(4)} shares

${statusLine}
`.trim();

    await this.sendMessage(message);
  }

  /**
   * Notify when the bot starts
   */
  async notifyBotStarted(config: {
    wallets: string[];
    accountSize: number;
    maxPositionSize: number;
    dryRun: boolean;
    tradingEnabled: boolean;
    positionCount: number;
  }): Promise<void> {
    const mode = !config.tradingEnabled
      ? 'Monitor Only'
      : config.dryRun
        ? 'Dry Run (Simulated)'
        : 'LIVE Trading';

    const modeEmoji = !config.tradingEnabled
      ? '⚪'
      : config.dryRun
        ? '🔶'
        : '🟢';

    const message = `
🚀 <b>Polybot Started</b>

<b>Mode:</b> ${modeEmoji} ${mode}
<b>Tracking:</b> ${config.wallets.join(', ') || 'None'}
<b>Account Size:</b> $${config.accountSize.toFixed(2)}
<b>Max Per Trade:</b> $${config.maxPositionSize.toFixed(2)}
<b>Current Positions:</b> ${config.positionCount}
`.trim();

    await this.sendMessage(message);
  }

  /**
   * Notify when the bot stops
   */
  async notifyBotStopped(stats?: {
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    totalVolume: number;
  }): Promise<void> {
    let message = '🛑 <b>Polybot Stopped</b>';

    if (stats) {
      const successRate = stats.totalTrades > 0
        ? ((stats.successfulTrades / stats.totalTrades) * 100).toFixed(1)
        : '0.0';

      message += `

<b>Session Stats:</b>
• Total Trades: ${stats.totalTrades}
• Successful: ${stats.successfulTrades}
• Failed: ${stats.failedTrades}
• Success Rate: ${successRate}%
• Volume: $${stats.totalVolume.toFixed(2)}`;
    }

    await this.sendMessage(message);
  }

  /**
   * Send daily summary
   */
  async sendDailySummary(summary: DailySummary): Promise<void> {
    const successRate = summary.totalTrades > 0
      ? ((summary.successfulTrades / summary.totalTrades) * 100).toFixed(1)
      : '0.0';

    let positionsText = '';
    if (summary.positions.length === 0) {
      positionsText = 'No open positions';
    } else {
      positionsText = summary.positions.map(pos => {
        const pnlText = pos.pnlPercent !== undefined
          ? ` (${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(1)}%)`
          : '';
        return `• ${pos.outcome} @ $${pos.avgPrice.toFixed(3)}${pnlText}`;
      }).join('\n');
    }

    const message = `
📊 <b>Daily Summary</b>

<b>Trading Stats:</b>
• Total Trades: ${summary.totalTrades}
• Successful: ${summary.successfulTrades}
• Failed: ${summary.failedTrades}
• Success Rate: ${successRate}%
• Volume: $${summary.totalVolume.toFixed(2)}

<b>Open Positions (${summary.positions.length}):</b>
${positionsText}
`.trim();

    await this.sendMessage(message);
  }

  /**
   * Generate and send daily summary from StateManager
   */
  async sendDailySummaryFromState(stateManager: StateManager): Promise<void> {
    const stats = stateManager.getStats();
    const positions = stateManager.getAllPositions();

    const summary: DailySummary = {
      totalTrades: stats.totalTrades,
      successfulTrades: stats.successfulTrades,
      failedTrades: stats.failedTrades,
      totalVolume: stats.totalVolume,
      positions: positions.map(pos => ({
        title: pos.title,
        outcome: pos.outcome,
        size: pos.size,
        avgPrice: pos.avgPrice,
      })),
    };

    await this.sendDailySummary(summary);
  }

  /**
   * Send a custom notification message
   */
  async notify(message: string): Promise<void> {
    await this.sendMessage(`📢 ${message}`);
  }
}
