import TelegramBot from 'node-telegram-bot-api';
import { UserDb } from '../../db/userDb.js';
import {
  settingsMenu, sizingMenu, riskMenu, filtersMenu,
  executionMenu, timeExitsMenu, keywordsMenu, conflictStrategyMenu,
  backButton,
} from '../menus.js';

// Track which setting is being edited per user
const pendingInput = new Map<string, { key: string; returnTo: string }>();

// Setting descriptions and validation
const settingInfo: Record<string, { label: string; unit: string; parse: (v: string) => number | null; returnMenu: string }> = {
  userAccountSize: { label: 'Account Size', unit: '$', parse: v => { const n = parseFloat(v); return n > 0 ? n : null; }, returnMenu: 'settings:sizing' },
  maxPositionSize: { label: 'Max Position Size', unit: '$', parse: v => { const n = parseFloat(v); return n > 0 ? n : null; }, returnMenu: 'settings:sizing' },
  minTradeSize: { label: 'Min Trade Size', unit: '$', parse: v => { const n = parseFloat(v); return n > 0 ? n : null; }, returnMenu: 'settings:sizing' },
  maxPercentagePerTrade: { label: 'Max % Per Trade', unit: '%', parse: v => { const n = parseFloat(v); return n > 0 && n <= 100 ? n : null; }, returnMenu: 'settings:sizing' },
  maxPositionValue: { label: 'Max Position Value', unit: '$ (0=unlimited)', parse: v => { const n = parseFloat(v); return n >= 0 ? n : null; }, returnMenu: 'settings:sizing' },
  stopLossPercent: { label: 'Stop Loss', unit: '% (negative, e.g. -25)', parse: v => { const n = parseFloat(v); return n < 0 ? n : null; }, returnMenu: 'settings:risk' },
  takeProfitPercent: { label: 'Take Profit', unit: '%', parse: v => { const n = parseFloat(v); return n > 0 ? n : null; }, returnMenu: 'settings:risk' },
  trailingStopPercent: { label: 'Trailing Stop', unit: '% (0=disabled)', parse: v => { const n = parseFloat(v); return n >= 0 ? n : null; }, returnMenu: 'settings:risk' },
  dailyLossLimit: { label: 'Daily Loss Limit', unit: '$ (0=disabled)', parse: v => { const n = parseFloat(v); return n >= 0 ? n : null; }, returnMenu: 'settings:risk' },
  maxOpenPositions: { label: 'Max Open Positions', unit: '(0=unlimited)', parse: v => { const n = parseInt(v); return n >= 0 ? n : null; }, returnMenu: 'settings:risk' },
  minProbability: { label: 'Min Probability', unit: '% (e.g. 5 for 5%)', parse: v => { const n = parseFloat(v); return n >= 0 && n <= 100 ? n / 100 : null; }, returnMenu: 'settings:filters' },
  maxProbability: { label: 'Max Probability', unit: '% (e.g. 95 for 95%)', parse: v => { const n = parseFloat(v); return n > 0 && n <= 100 ? n / 100 : null; }, returnMenu: 'settings:filters' },
  orderSlippagePercent: { label: 'Slippage', unit: '%', parse: v => { const n = parseFloat(v); return n >= 0 && n <= 50 ? n : null; }, returnMenu: 'settings:execution' },
  maxHoldTimeHours: { label: 'Max Hold Time', unit: 'hours (0=disabled)', parse: v => { const n = parseFloat(v); return n >= 0 ? n : null; }, returnMenu: 'settings:time' },
  blacklistKeywords: { label: 'Blacklist Keywords', unit: 'comma-separated', parse: v => null, returnMenu: 'settings:keywords' },
  whitelistKeywords: { label: 'Whitelist Keywords', unit: 'comma-separated', parse: v => null, returnMenu: 'settings:keywords' },
};

export function registerSettingsHandler(bot: TelegramBot, db: UserDb): void {

  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id.toString();
    const settings = db.getSettings(chatId);

    // Settings main menu
    if (query.data === 'menu:settings') {
      await bot.editMessageText('⚙️ <b>Settings</b>\n\nConfigure your trading parameters:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: settingsMenu(),
      });
      await bot.answerCallbackQuery(query.id);
    }

    // Sub-menus
    if (query.data === 'settings:sizing') {
      await bot.editMessageText('💰 <b>Position Sizing</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: sizingMenu(settings),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'settings:risk') {
      await bot.editMessageText('🛡 <b>Risk Management</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: riskMenu(settings),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'settings:filters') {
      await bot.editMessageText('🔍 <b>Trade Filters</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: filtersMenu(settings),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'settings:execution') {
      await bot.editMessageText('⚡ <b>Execution Settings</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: executionMenu(settings),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'settings:time') {
      await bot.editMessageText('⏰ <b>Time-Based Exits</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: timeExitsMenu(settings),
      });
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'settings:keywords') {
      await bot.editMessageText(
        '📝 <b>Keywords</b>\n\n' +
        `<b>Blacklist:</b> ${settings.blacklistKeywords || 'none'}\n` +
        `<b>Whitelist:</b> ${settings.whitelistKeywords || 'none'}`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: keywordsMenu(settings),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    // Set a specific value
    if (query.data?.startsWith('set:')) {
      const key = query.data.slice(4);
      const info = settingInfo[key];
      if (!info) return;

      pendingInput.set(chatId, { key, returnTo: info.returnMenu });

      await bot.editMessageText(
        `✏️ <b>Set ${info.label}</b>\n\n` +
        `Current value: <b>${(settings as any)[key]}</b>\n` +
        `Enter new value (${info.unit}):`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: backButton(info.returnMenu),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    // Toggle boolean settings
    if (query.data?.startsWith('toggle:')) {
      const key = query.data.slice(7);
      const currentValue = (settings as any)[key];
      const newValue = !currentValue;
      db.updateSetting(chatId, key, newValue);

      await bot.answerCallbackQuery(query.id, { text: `${key} = ${newValue ? 'ON' : 'OFF'}` });

      // Refresh the appropriate menu
      const updatedSettings = db.getSettings(chatId);
      if (key === 'copySells') {
        await bot.editMessageText('⚡ <b>Execution Settings</b>\n\nTap a setting to change it:', {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: executionMenu(updatedSettings),
        });
      } else if (key === 'dryRun') {
        const { tradingMenu } = await import('../menus.js');
        await bot.editMessageText(
          `▶️ <b>Trading Control</b>\n\nDry Run: ${updatedSettings.dryRun ? '✅ Simulated' : '❌ LIVE'}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: tradingMenu(updatedSettings.enableTrading, updatedSettings.dryRun),
          }
        );
      }
    }

    // Conflict strategy selection
    if (query.data === 'set:conflictStrategy') {
      await bot.editMessageText(
        '⚔️ <b>Conflict Strategy</b>\n\n' +
        'When followed traders make opposite trades:\n\n' +
        '🥇 <b>First</b> - Follow the first signal\n' +
        '⏭ <b>Skip</b> - Don\'t trade on conflicts\n' +
        '👥 <b>Majority</b> - Follow the majority\n' +
        '💎 <b>Highest Allocation</b> - Follow the highest-allocated trader',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: conflictStrategyMenu(),
        }
      );
      await bot.answerCallbackQuery(query.id);
    }

    if (query.data?.startsWith('conflict:')) {
      const strategy = query.data.slice(9);
      db.updateSetting(chatId, 'conflictStrategy', strategy);
      await bot.answerCallbackQuery(query.id, { text: `✅ Strategy: ${strategy}` });
      const updatedSettings = db.getSettings(chatId);
      await bot.editMessageText('⚡ <b>Execution Settings</b>\n\nTap a setting to change it:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: executionMenu(updatedSettings),
      });
    }
  });

  // Handle text input for setting values
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id.toString();
    const pending = pendingInput.get(chatId);
    if (!pending) return;

    const info = settingInfo[pending.key];
    if (!info) {
      pendingInput.delete(chatId);
      return;
    }

    // Handle string settings (keywords)
    if (pending.key === 'blacklistKeywords' || pending.key === 'whitelistKeywords') {
      const value = msg.text.trim();
      db.updateSetting(chatId, pending.key, value);
      pendingInput.delete(chatId);

      const settings = db.getSettings(chatId);
      await bot.sendMessage(chatId,
        `✅ <b>${info.label}</b> updated to: ${value || 'none'}`,
        {
          parse_mode: 'HTML',
          reply_markup: keywordsMenu(settings),
        }
      );
      return;
    }

    // Handle numeric settings
    const parsed = info.parse(msg.text.trim());
    if (parsed === null) {
      await bot.sendMessage(chatId, `❌ Invalid value. Expected: ${info.unit}\n\nTry again:`, {
        reply_markup: backButton(pending.returnTo),
      });
      return;
    }

    db.updateSetting(chatId, pending.key, parsed);
    pendingInput.delete(chatId);

    const settings = db.getSettings(chatId);
    // Send confirmation and show the appropriate sub-menu
    const menuFns: Record<string, () => TelegramBot.InlineKeyboardMarkup> = {
      'settings:sizing': () => sizingMenu(settings),
      'settings:risk': () => riskMenu(settings),
      'settings:filters': () => filtersMenu(settings),
      'settings:execution': () => executionMenu(settings),
      'settings:time': () => timeExitsMenu(settings),
      'settings:keywords': () => keywordsMenu(settings),
    };

    const menuFn = menuFns[pending.returnTo];
    await bot.sendMessage(chatId,
      `✅ <b>${info.label}</b> updated to: <b>${parsed}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: menuFn ? menuFn() : backButton('menu:settings'),
      }
    );
  });
}
