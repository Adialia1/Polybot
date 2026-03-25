import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { walletsMenu, walletTypeMenu, backButton } from '../menus.js';
import { privateKeyToAccount } from 'viem/accounts';

// Track conversation state for wallet connection flow
const walletFlowState = new Map<string, { step: string; signatureType: number; privateKey?: string; walletAddress?: string; funderAddress?: string }>();

export function registerWalletHandler(bot: TelegramBot, db: UserDb): void {

  // Handle menu:wallets callback
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:wallets') {
      const wallets = db.getWallets(chatId);
      await bot.editMessageText('🔑 <b>Wallet Management</b>\n\nConnect your Polymarket wallet to start trading.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: walletsMenu(wallets.length > 0),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'wallet:connect') {
      await bot.editMessageText(
        '🔑 <b>Connect Wallet</b>\n\n' +
        'Select your wallet type:\n\n' +
        '🦊 <b>Browser Wallet</b> - MetaMask/Rabby with Polymarket proxy (most common)\n' +
        '📧 <b>Email Wallet</b> - Magic Link login, exported private key\n' +
        '🔐 <b>EOA</b> - Standalone wallet, signer is funder',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: walletTypeMenu(),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    // Wallet type selection
    if (query.data?.startsWith('wallet:type:')) {
      const signatureType = parseInt(query.data.split(':')[2]);
      walletFlowState.set(chatId, { step: 'private_key', signatureType });

      await bot.editMessageText(
        '🔐 <b>Step 1: Private Key</b>\n\n' +
        'Send your private key (starts with 0x).\n\n' +
        '⚠️ Your key will be encrypted and stored securely.\n' +
        '⚠️ <b>Delete your message after sending!</b>',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: backButton('menu:wallets'),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    // List wallets
    if (query.data === 'wallet:list') {
      const wallets = db.getWallets(chatId);
      if (wallets.length === 0) {
        await bot.editMessageText('📭 No wallets connected.', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: walletsMenu(false),
        });
      } else {
        let text = '📋 <b>Your Wallets</b>\n\n';
        wallets.forEach((w, i) => {
          const addr = w.walletAddress;
          const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
          const defaultTag = w.isDefault ? ' ⭐ Default' : '';
          const typeNames: Record<number, string> = { 0: 'EOA', 1: 'Email', 2: 'Browser' };
          text += `${i + 1}. <b>${w.alias}</b>${defaultTag}\n`;
          text += `   📍 Address: <code>${short}</code>\n`;
          text += `   🏷 Type: ${typeNames[w.signatureType] || 'Unknown'}\n\n`;
        });
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: walletsMenu(true),
        });
      }
      await bot.answerCallbackQuery(query.id);
    }

    // Remove wallet list
    if (query.data === 'wallet:remove_list') {
      const wallets = db.getWallets(chatId);
      const buttons = wallets.map(w => {
        const short = `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`;
        return [{ text: `🗑 ${w.alias} (${short})`, callback_data: `wallet:remove:${w.id}` }];
      });
      buttons.push([{ text: '⬅️ Back', callback_data: 'menu:wallets' }]);
      await bot.editMessageText('🗑 <b>Remove Wallet</b>\n\nSelect wallet to remove:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      await bot.answerCallbackQuery(query.id);
    }

    // Remove specific wallet
    if (query.data?.startsWith('wallet:remove:')) {
      const walletId = parseInt(query.data.split(':')[2]);
      db.removeWallet(chatId, walletId);
      const wallets = db.getWallets(chatId);
      await bot.editMessageText('✅ Wallet removed successfully.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: walletsMenu(wallets.length > 0),
      });
      await bot.answerCallbackQuery(query.id);
    }
  });

  // Handle text messages for wallet connection flow
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id.toString();
    const state = walletFlowState.get(chatId);
    if (!state) return;

    if (state.step === 'private_key') {
      const key = msg.text.trim();

      // Try to delete the message containing the private key for security
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

      if (!key.startsWith('0x') || key.length < 64) {
        await bot.sendMessage(chatId, '❌ Invalid private key. Must start with 0x and be 66 characters long.\n\nTry again or press Back.', {
          parse_mode: 'HTML',
          reply_markup: backButton('menu:wallets'),
        });
        return;
      }

      try {
        // Derive address from private key
        const account = privateKeyToAccount(key as `0x${string}`);
        state.privateKey = key;
        state.walletAddress = account.address;

        if (state.signatureType === 0) {
          // EOA: signer is funder, no need for funder address
          state.funderAddress = account.address;
          state.step = 'alias';
          await bot.sendMessage(chatId,
            `✅ Key accepted!\n\n` +
            `📍 Address: <code>${account.address}</code>\n\n` +
            `<b>Step 2:</b> ✏️ Send a name/alias for this wallet (e.g., "Main", "Trading"):`,
            { parse_mode: 'HTML', reply_markup: backButton('menu:wallets') }
          );
        } else {
          // Need funder/proxy address
          state.step = 'funder_address';
          await bot.sendMessage(chatId,
            `✅ Key accepted!\n\n` +
            `📍 Signer: <code>${account.address}</code>\n\n` +
            `<b>Step 2:</b> 📬 Send your Polymarket proxy/funder wallet address:`,
            { parse_mode: 'HTML', reply_markup: backButton('menu:wallets') }
          );
        }
      } catch (err: any) {
        await bot.sendMessage(chatId, `❌ Invalid private key: ${err.message}\n\nTry again:`, {
          reply_markup: backButton('menu:wallets'),
        });
      }
      return;
    }

    if (state.step === 'funder_address') {
      const addr = msg.text.trim();
      if (!addr.startsWith('0x') || addr.length !== 42) {
        await bot.sendMessage(chatId, '❌ Invalid address. Must be 42 characters starting with 0x.\n\nTry again:', {
          reply_markup: backButton('menu:wallets'),
        });
        return;
      }
      state.funderAddress = addr;
      state.step = 'alias';
      await bot.sendMessage(chatId,
        `✅ Funder address set!\n\n` +
        `<b>Step 3:</b> ✏️ Send a name/alias for this wallet (e.g., "Main", "Trading"):`,
        { parse_mode: 'HTML', reply_markup: backButton('menu:wallets') }
      );
      return;
    }

    if (state.step === 'alias') {
      const alias = msg.text.trim().slice(0, 20);

      try {
        db.addWallet(
          chatId,
          state.privateKey!,
          state.walletAddress!,
          state.funderAddress,
          alias,
          state.signatureType
        );

        walletFlowState.delete(chatId);

        const short = `${state.walletAddress!.slice(0, 6)}...${state.walletAddress!.slice(-4)}`;
        await bot.sendMessage(chatId,
          `✅ <b>Wallet Connected!</b>\n\n` +
          `🏷 Name: <b>${alias}</b>\n` +
          `📍 Address: <code>${short}</code>\n\n` +
          `🎉 You can now follow traders and start copy-trading!`,
          {
            parse_mode: 'HTML',
            reply_markup: walletsMenu(true),
          }
        );
      } catch (err: any) {
        await bot.sendMessage(chatId, `❌ Error saving wallet: ${err.message}`, {
          reply_markup: backButton('menu:wallets'),
        });
      }
      return;
    }
  });
}

// Export for cleanup
export function clearWalletFlowState(chatId: string): void {
  walletFlowState.delete(chatId);
}
