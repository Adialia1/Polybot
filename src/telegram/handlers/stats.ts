import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { backButton } from '../menus.js';

export function registerStatsHandler(bot: TelegramBot, db: UserDb): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:stats') {
      const state = db.getUserState(chatId);
      const stats = state.stats || {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalVolume: 0,
      };

      const successRate = stats.totalTrades > 0
        ? ((stats.successfulTrades / stats.totalTrades) * 100).toFixed(1)
        : '0.0';

      const positions = state.positions ? Object.values(state.positions) : [];
      const totalValue = (positions as any[]).reduce((sum: number, p: any) => sum + (p.size || 0) * (p.avgPrice || 0), 0);

      // Per-trader stats
      let traderStatsText = '';
      if (state.traderStats) {
        const entries = Object.entries(state.traderStats) as [string, any][];
        if (entries.length > 0) {
          traderStatsText = '\n\n<b>👥 Per-Trader Stats:</b>\n';
          entries.forEach(([alias, ts]) => {
            const winRate = ts.totalTrades > 0 ? ((ts.wins / ts.totalTrades) * 100).toFixed(0) : '0';
            traderStatsText += `• <b>${alias}</b>: ${ts.totalTrades} trades, ${winRate}% win, P&L: $${ts.totalPnL?.toFixed(2) || '0.00'}\n`;
          });
        }
      }

      const message = `
📈 <b>Trading Statistics</b>

<b>🔢 Total Trades:</b> ${stats.totalTrades}
<b>✅ Successful:</b> ${stats.successfulTrades}
<b>❌ Failed:</b> ${stats.failedTrades}
<b>🎯 Success Rate:</b> ${successRate}%
<b>💰 Total Volume:</b> $${(stats.totalVolume || 0).toFixed(2)}

<b>📦 Open Positions:</b> ${positions.length}
<b>💵 Total Position Value:</b> $${totalValue.toFixed(2)}
<b>📊 Daily P&L:</b> $${(state.dailyPnL || 0).toFixed(2)}${traderStatsText}
      `.trim();

      const buttons = [
        [{ text: '🔄 Refresh', callback_data: 'menu:stats' }],
        [{ text: '⬅️ Back', callback_data: 'menu:main' }],
      ];

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      await bot.answerCallbackQuery(query.id);
    }
  });
}
