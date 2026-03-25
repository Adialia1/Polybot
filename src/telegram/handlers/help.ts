import TelegramBot from 'node-telegram-bot-api';
import { mainMenu } from '../menus.js';

export function registerHelpHandler(bot: TelegramBot): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();

    if (query.data === 'menu:help') {
      const helpText = `
❓ <b>Polybot Help</b>

<b>Getting Started:</b>
1. 🔑 Connect your Polymarket wallet
2. 👁 Add traders to follow
3. ⚙️ Configure your settings
4. ▶️ Start trading!

<b>🔧 How it works:</b>
• 📡 Monitors followed traders in real-time
• 🔄 Copies their trades to your wallet
• ⚖️ Scales position sizes to your account
• 🛡 Manages exits via stop-loss, take-profit, trailing stops

<b>💼 Wallet Types:</b>
• 🦊 <b>Browser</b> - MetaMask/Rabby with Polymarket proxy
• 📧 <b>Email</b> - Magic Link exported key
• 🔐 <b>EOA</b> - Standalone wallet

<b>⚙️ Key Settings:</b>
• 🎚 <b>Slippage</b> - Max price deviation allowed
• 🔻 <b>Stop Loss</b> - Auto-sell at loss threshold
• 🎯 <b>Take Profit</b> - Auto-sell at profit target
• 📉 <b>Trailing Stop</b> - Lock in profits as price rises
• 🧪 <b>Dry Run</b> - Test without real trades

<b>📋 Commands:</b>
/start - 🏠 Main menu
/menu - 📱 Show menu
/help - ❓ This help message

<b>💡 Tips:</b>
• 🧪 Start with Dry Run mode ON
• 🤏 Use small position sizes initially
• 🌐 Diversify across multiple traders
• 🛡 Set stop-loss to protect capital
      `.trim();

      await bot.editMessageText(helpText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: mainMenu(),
      });
      await bot.answerCallbackQuery(query.id);
    }

    // Handle main menu callback
    if (query.data === 'menu:main') {
      await bot.editMessageText('🤖 <b>Main Menu</b>', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: mainMenu(),
      });
      await bot.answerCallbackQuery(query.id);
    }
  });
}
