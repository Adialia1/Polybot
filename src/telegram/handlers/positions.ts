import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { positionsMenu, confirmMenu, backButton } from '../menus.js';
import type { UserBotManager } from '../../services/userBotManager.js';

export function registerPositionsHandler(bot: TelegramBot, db: UserDb, getBotManager: () => UserBotManager): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:positions') {
      const state = db.getUserState(chatId);
      const positions = state.positions ? Object.values(state.positions) : [];
      const hasPositions = positions.length > 0;

      await bot.editMessageText(
        `📊 <b>Positions</b>\n\nOpen positions: ${positions.length}`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: positionsMenu(hasPositions),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'positions:list') {
      const state = db.getUserState(chatId);
      const positions = state.positions ? Object.entries(state.positions) : [];

      if (positions.length === 0) {
        await bot.editMessageText('📊 <b>No open positions</b>', {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: positionsMenu(false),
        });
      } else {
        let text = '📊 <b>Open Positions</b>\n\n';
        (positions as [string, any][]).forEach(([asset, pos], i) => {
          text += `${i + 1}. <b>${pos.outcome}</b>\n`;
          text += `   Market: ${pos.title?.slice(0, 40) || 'Unknown'}\n`;
          text += `   Size: ${pos.size?.toFixed(4) || '?'} shares @ $${pos.avgPrice?.toFixed(3) || '?'}\n`;
          text += `   Value: $${((pos.size || 0) * (pos.avgPrice || 0)).toFixed(2)}\n`;
          if (pos.walletAlias) text += `   Copied from: ${pos.walletAlias}\n`;
          text += '\n';
        });

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: positionsMenu(true),
        });
      }
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'positions:sell_list') {
      const state = db.getUserState(chatId);
      const positions = state.positions ? Object.entries(state.positions) : [];

      if (positions.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: 'No positions to sell' });
        return;
      }

      const buttons = (positions as [string, any][]).map(([asset, pos]) => [{
        text: `🔴 ${pos.outcome} (${pos.size?.toFixed(2) || '?'} shares)`,
        callback_data: `positions:sell:${asset.slice(0, 40)}`,
      }]);
      buttons.push([{ text: '⬅️ Back', callback_data: 'menu:positions' }]);

      await bot.editMessageText('🔴 <b>Sell Position</b>\n\nSelect position to sell:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data?.startsWith('positions:sell:')) {
      const assetPrefix = query.data.slice(14);
      const botManager = getBotManager();
      const userBot = botManager.getUserBot(chatId);

      if (!userBot) {
        await bot.answerCallbackQuery(query.id, { text: 'Trading not active. Start trading first.' });
        return;
      }

      await bot.editMessageText(`⏳ Selling position...`, {
        chat_id: chatId,
        message_id: query.message.message_id,
      });

      try {
        const state = db.getUserState(chatId);
        const positions = state.positions || {};
        const matchingAsset = Object.keys(positions).find(a => a.startsWith(assetPrefix));

        if (matchingAsset && userBot.trader) {
          const pos = positions[matchingAsset];
          const result = await userBot.trader.sellPosition(matchingAsset, pos.size, pos.avgPrice || 0.5, pos.title || 'Unknown');
          if (result.success) {
            delete positions[matchingAsset];
            state.positions = positions;
            db.saveUserState(chatId, state);
            await bot.editMessageText(`✅ Position sold! Order: ${result.orderId || 'completed'}`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              reply_markup: positionsMenu(Object.keys(positions).length > 0),
            });
          } else {
            await bot.editMessageText(`❌ Sell failed: ${result.error}`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              reply_markup: positionsMenu(true),
            });
          }
        }
      } catch (err: any) {
        await bot.editMessageText(`❌ Error: ${err.message}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: positionsMenu(true),
        });
      }
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'positions:sell_all') {
      await bot.editMessageText('⚠️ <b>Sell ALL positions?</b>\n\nThis will sell all your open positions at market price.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: confirmMenu('sell_all'),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'confirm:sell_all') {
      const botManager = getBotManager();
      const userBot = botManager.getUserBot(chatId);

      if (!userBot || !userBot.trader) {
        await bot.editMessageText('❌ Trading not active.', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: positionsMenu(false),
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }

      await bot.editMessageText('⏳ Selling all positions...', {
        chat_id: chatId,
        message_id: query.message.message_id,
      });

      const state = db.getUserState(chatId);
      const positions = state.positions || {};
      let sold = 0;
      let failed = 0;

      for (const [asset, pos] of Object.entries(positions) as [string, any][]) {
        try {
          const result = await userBot.trader.sellPosition(asset, pos.size, pos.avgPrice || 0.5, pos.title || 'Unknown');
          if (result.success) {
            delete positions[asset];
            sold++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      state.positions = positions;
      db.saveUserState(chatId, state);

      await bot.editMessageText(
        `✅ Sold: ${sold}, Failed: ${failed}`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: positionsMenu(Object.keys(positions).length > 0),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }
  });
}
