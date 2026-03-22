import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { followMenu, backButton } from '../menus.js';

const followFlowState = new Map<string, { step: string; address?: string }>();

export function registerFollowHandler(bot: TelegramBot, db: UserDb): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:follow') {
      const tracked = db.getTrackedWallets(chatId);
      await bot.editMessageText(
        '👁 <b>Follow Traders</b>\n\n' +
        'Add Polymarket wallets to copy-trade from.\n' +
        `Currently following: ${tracked.filter(t => t.enabled).length} trader(s)`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: followMenu(tracked.length > 0),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'follow:add') {
      followFlowState.set(chatId, { step: 'address' });
      await bot.editMessageText(
        '➕ <b>Add Trader</b>\n\n' +
        'Send the Polymarket wallet address to follow (0x...):\n\n' +
        'You can find trader addresses on polymarket.com/profile/[address]',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: backButton('menu:follow'),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'follow:list') {
      const tracked = db.getTrackedWallets(chatId);
      if (tracked.length === 0) {
        await bot.editMessageText('No traders being followed.', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: followMenu(false),
        });
      } else {
        let text = '📋 <b>Followed Traders</b>\n\n';
        tracked.forEach((t, i) => {
          const short = `${t.walletAddress.slice(0, 6)}...${t.walletAddress.slice(-4)}`;
          const status = t.enabled ? '✅' : '❌';
          text += `${i + 1}. ${status} <b>${t.alias}</b>\n`;
          text += `   Address: <code>${short}</code>\n`;
          text += `   Allocation: ${t.allocation}%\n\n`;
        });

        const buttons = tracked.map(t => [
          {
            text: `${t.enabled ? '❌ Disable' : '✅ Enable'} ${t.alias}`,
            callback_data: `follow:toggle:${t.id}`,
          },
        ]);
        buttons.push([{ text: '⬅️ Back', callback_data: 'menu:follow' }]);

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });
      }
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data?.startsWith('follow:toggle:')) {
      const id = parseInt(query.data.split(':')[2]);
      const enabled = db.toggleTrackedWallet(chatId, id);
      await bot.answerCallbackQuery(query.id, { text: enabled ? 'Trader enabled' : 'Trader disabled' });
      // Refresh the list
      const tracked = db.getTrackedWallets(chatId);
      let text = '📋 <b>Followed Traders</b>\n\n';
      tracked.forEach((t, i) => {
        const short = `${t.walletAddress.slice(0, 6)}...${t.walletAddress.slice(-4)}`;
        const status = t.enabled ? '✅' : '❌';
        text += `${i + 1}. ${status} <b>${t.alias}</b>\n`;
        text += `   Address: <code>${short}</code>\n`;
        text += `   Allocation: ${t.allocation}%\n\n`;
      });
      const buttons = tracked.map(t => [
        {
          text: `${t.enabled ? '❌ Disable' : '✅ Enable'} ${t.alias}`,
          callback_data: `follow:toggle:${t.id}`,
        },
      ]);
      buttons.push([{ text: '⬅️ Back', callback_data: 'menu:follow' }]);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    }

    if (query.data === 'follow:remove_list') {
      const tracked = db.getTrackedWallets(chatId);
      const buttons = tracked.map(t => {
        const short = `${t.walletAddress.slice(0, 6)}...${t.walletAddress.slice(-4)}`;
        return [{ text: `🗑 ${t.alias} (${short})`, callback_data: `follow:remove:${t.id}` }];
      });
      buttons.push([{ text: '⬅️ Back', callback_data: 'menu:follow' }]);
      await bot.editMessageText('🗑 <b>Remove Trader</b>\n\nSelect trader to remove:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data?.startsWith('follow:remove:')) {
      const id = parseInt(query.data.split(':')[2]);
      db.removeTrackedWallet(chatId, id);
      const tracked = db.getTrackedWallets(chatId);
      await bot.editMessageText('✅ Trader removed.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: followMenu(tracked.length > 0),
      });
      await bot.answerCallbackQuery(query.id);
    }
  });

  // Handle text messages for follow flow
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id.toString();
    const state = followFlowState.get(chatId);
    if (!state) return;

    if (state.step === 'address') {
      const addr = msg.text.trim();
      if (!addr.startsWith('0x') || addr.length !== 42) {
        await bot.sendMessage(chatId, '❌ Invalid address. Must be 42 characters starting with 0x.\n\nTry again:', {
          reply_markup: backButton('menu:follow'),
        });
        return;
      }
      state.address = addr;
      state.step = 'alias';
      await bot.sendMessage(chatId,
        `✅ Address: <code>${addr.slice(0, 6)}...${addr.slice(-4)}</code>\n\n` +
        `Send a name/alias for this trader (e.g., "Whale1", "TopTrader"):`,
        { parse_mode: 'HTML', reply_markup: backButton('menu:follow') }
      );
      return;
    }

    if (state.step === 'alias') {
      const alias = msg.text.trim().slice(0, 20);
      state.step = 'allocation';
      followFlowState.set(chatId, { ...state, step: 'allocation' });
      await bot.sendMessage(chatId,
        `Name: <b>${alias}</b>\n\n` +
        `Send allocation percentage (1-100):\n` +
        `This controls what % of calculated position size to use for this trader.\n` +
        `(100 = full size, 50 = half size)`,
        { parse_mode: 'HTML', reply_markup: backButton('menu:follow') }
      );
      // Store alias temporarily
      (state as any).alias = alias;
      return;
    }

    if (state.step === 'allocation') {
      const allocation = parseInt(msg.text.trim());
      if (isNaN(allocation) || allocation < 1 || allocation > 100) {
        await bot.sendMessage(chatId, '❌ Invalid allocation. Enter a number between 1 and 100:', {
          reply_markup: backButton('menu:follow'),
        });
        return;
      }

      try {
        db.addTrackedWallet(chatId, state.address!, (state as any).alias, allocation);
        followFlowState.delete(chatId);

        const tracked = db.getTrackedWallets(chatId);
        await bot.sendMessage(chatId,
          `✅ <b>Trader Added!</b>\n\n` +
          `Name: <b>${(state as any).alias}</b>\n` +
          `Address: <code>${state.address!.slice(0, 6)}...${state.address!.slice(-4)}</code>\n` +
          `Allocation: ${allocation}%`,
          {
            parse_mode: 'HTML',
            reply_markup: followMenu(tracked.length > 0),
          }
        );
      } catch (err: any) {
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
          reply_markup: backButton('menu:follow'),
        });
      }
      return;
    }
  });
}
