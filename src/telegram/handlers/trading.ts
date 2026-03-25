import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { tradingMenu, backButton } from '../menus.js';
import type { UserBotManager } from '../../services/userBotManager.js';

export function registerTradingHandler(bot: TelegramBot, db: UserDb, getBotManager: () => UserBotManager): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:trading') {
      const settings = db.getSettings(chatId);
      const botManager = getBotManager();
      const isRunning = botManager.isUserRunning(chatId);

      const wallets = db.getWallets(chatId);
      const tracked = db.getTrackedWallets(chatId).filter(t => t.enabled);

      let statusText = '▶️ <b>Trading Control</b>\n\n';
      statusText += `Status: ${isRunning ? '🟢 RUNNING' : '⏹ STOPPED'}\n`;
      statusText += `Mode: ${settings.dryRun ? '🔶 Dry Run' : '🟢 LIVE'}\n`;
      statusText += `💼 Wallets: ${wallets.length}\n`;
      statusText += `👁 Following: ${tracked.length} traders\n`;

      if (wallets.length === 0) {
        statusText += '\n⚠️ Connect a wallet first!';
      }
      if (tracked.length === 0) {
        statusText += '\n⚠️ Follow at least one trader first!';
      }

      await bot.editMessageText(statusText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: tradingMenu(isRunning, settings.dryRun),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'trading:start') {
      const wallets = db.getWallets(chatId);
      const tracked = db.getTrackedWallets(chatId).filter(t => t.enabled);

      if (wallets.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Connect a wallet first!', show_alert: true });
        return;
      }
      if (tracked.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Follow at least one trader first!', show_alert: true });
        return;
      }

      const botManager = getBotManager();
      try {
        await botManager.startUserBot(chatId);
        const settings = db.getSettings(chatId);

        await bot.editMessageText(
          `🟢 <b>Trading Started!</b>\n\n` +
          `Mode: ${settings.dryRun ? '🔶 Dry Run (simulated)' : '🟢 LIVE'}\n` +
          `👁 Following: ${tracked.length} trader(s)\n` +
          `💰 Max position: $${settings.maxPositionSize}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: tradingMenu(true, settings.dryRun),
          }
        );
      } catch (err: any) {
        await bot.editMessageText(`❌ Failed to start: ${err.message}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: tradingMenu(false, db.getSettings(chatId).dryRun),
        });
      }
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'trading:stop') {
      const botManager = getBotManager();
      await botManager.stopUserBot(chatId);
      const settings = db.getSettings(chatId);

      await bot.editMessageText('⏹ <b>Trading Stopped</b>', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: tradingMenu(false, settings.dryRun),
      });
      await bot.answerCallbackQuery(query.id);
    }
  });
}
