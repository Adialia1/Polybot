import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import { mainMenu } from '../menus.js';

export function registerStartHandler(bot: TelegramBot, db: UserDb): void {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const username = msg.from?.username || msg.from?.first_name || null;
    db.ensureUser(chatId, username || undefined);

    const wallets = db.getWallets(chatId);
    const tracked = db.getTrackedWallets(chatId);

    let welcome = `🤖 <b>Welcome to Polybot!</b>\n\n`;
    welcome += `🤝 Multi-user Polymarket copy-trading bot.\n\n`;
    welcome += `<b>📋 Status:</b>\n`;
    welcome += `• 💼 Wallets: ${wallets.length} connected\n`;
    welcome += `• 👁 Following: ${tracked.filter(t => t.enabled).length} traders\n\n`;

    if (wallets.length === 0) {
      welcome += `👉 Start by connecting your wallet!\n`;
    }

    await bot.sendMessage(chatId, welcome, {
      parse_mode: 'HTML',
      reply_markup: mainMenu(),
    });
  });

  // Also handle /menu to show main menu
  bot.onText(/\/menu/, async (msg) => {
    const chatId = msg.chat.id.toString();
    db.ensureUser(chatId, msg.from?.username || undefined);

    await bot.sendMessage(chatId, '🤖 <b>Main Menu</b>', {
      parse_mode: 'HTML',
      reply_markup: mainMenu(),
    });
  });
}
