import * as TelegramBot from 'node-telegram-bot-api';
import { StateManager } from './stateManager.js';

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

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (token && chatId) {
      try {
        this.bot = new TelegramBot(token, { polling: false });
        this.chatId = chatId;
        this.enabled = true;
        console.log('[Notifier] Telegram notifications enabled');
      } catch (error) {
        console.warn('[Notifier] Failed to initialize Telegram bot:', error);
        this.enabled = false;
      }
    } else {
      console.log('[Notifier] Telegram notifications disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    }
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
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
