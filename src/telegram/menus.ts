import TelegramBot from 'node-telegram-bot-api';

type InlineButton = TelegramBot.InlineKeyboardButton;
type InlineMarkup = TelegramBot.InlineKeyboardMarkup;

function btn(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
}

export function mainMenu(): InlineMarkup {
  return {
    inline_keyboard: [
      [btn('🔑 Wallets', 'menu:wallets'), btn('👁 Follow Traders', 'menu:follow')],
      [btn('⚙️ Settings', 'menu:settings'), btn('📊 Positions', 'menu:positions')],
      [btn('📈 Stats', 'menu:stats'), btn('▶️ Trading', 'menu:trading')],
      [btn('❓ Help', 'menu:help')],
    ],
  };
}

export function walletsMenu(hasWallets: boolean): InlineMarkup {
  const buttons: InlineButton[][] = [
    [btn('➕ Connect Wallet', 'wallet:connect')],
  ];
  if (hasWallets) {
    buttons.push([btn('📋 My Wallets', 'wallet:list'), btn('🗑 Remove Wallet', 'wallet:remove_list')]);
  }
  buttons.push([btn('⬅️ Back', 'menu:main')]);
  return { inline_keyboard: buttons };
}

export function walletTypeMenu(): InlineMarkup {
  return {
    inline_keyboard: [
      [btn('🦊 Browser Wallet (MetaMask/Rabby)', 'wallet:type:2')],
      [btn('📧 Email Wallet (Magic Link)', 'wallet:type:1')],
      [btn('🔐 EOA (Standalone)', 'wallet:type:0')],
      [btn('⬅️ Back', 'menu:wallets')],
    ],
  };
}

export function followMenu(hasTracked: boolean): InlineMarkup {
  const buttons: InlineButton[][] = [
    [btn('➕ Add Trader', 'follow:add')],
  ];
  if (hasTracked) {
    buttons.push([btn('📋 List Traders', 'follow:list'), btn('🗑 Remove Trader', 'follow:remove_list')]);
  }
  buttons.push([btn('⬅️ Back', 'menu:main')]);
  return { inline_keyboard: buttons };
}

export function settingsMenu(): InlineMarkup {
  return {
    inline_keyboard: [
      [btn('💰 Position Sizing', 'settings:sizing'), btn('🛡 Risk Management', 'settings:risk')],
      [btn('🔍 Trade Filters', 'settings:filters'), btn('⚡ Execution', 'settings:execution')],
      [btn('⏰ Time Exits', 'settings:time'), btn('📝 Keywords', 'settings:keywords')],
      [btn('⬅️ Back', 'menu:main')],
    ],
  };
}

export function sizingMenu(settings: any): InlineMarkup {
  return {
    inline_keyboard: [
      [btn(`💵 Account Size: $${settings.userAccountSize}`, 'set:userAccountSize')],
      [btn(`📏 Max Position: $${settings.maxPositionSize}`, 'set:maxPositionSize')],
      [btn(`🔻 Min Trade: $${settings.minTradeSize}`, 'set:minTradeSize')],
      [btn(`📊 Max % Per Trade: ${settings.maxPercentagePerTrade}%`, 'set:maxPercentagePerTrade')],
      [btn(`🏷 Max Position Value: $${settings.maxPositionValue || '∞'}`, 'set:maxPositionValue')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function riskMenu(settings: any): InlineMarkup {
  return {
    inline_keyboard: [
      [btn(`🔻 Stop Loss: ${settings.stopLossPercent}%`, 'set:stopLossPercent')],
      [btn(`🎯 Take Profit: +${settings.takeProfitPercent}%`, 'set:takeProfitPercent')],
      [btn(`📉 Trailing Stop: ${settings.trailingStopPercent}%`, 'set:trailingStopPercent')],
      [btn(`🚫 Daily Loss Limit: $${settings.dailyLossLimit || '∞'}`, 'set:dailyLossLimit')],
      [btn(`📦 Max Open Positions: ${settings.maxOpenPositions || '∞'}`, 'set:maxOpenPositions')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function filtersMenu(settings: any): InlineMarkup {
  return {
    inline_keyboard: [
      [btn(`⬇️ Min Probability: ${(settings.minProbability * 100).toFixed(0)}%`, 'set:minProbability')],
      [btn(`⬆️ Max Probability: ${(settings.maxProbability * 100).toFixed(0)}%`, 'set:maxProbability')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function executionMenu(settings: any): InlineMarkup {
  return {
    inline_keyboard: [
      [btn(`🎚 Slippage: ${settings.orderSlippagePercent}%`, 'set:orderSlippagePercent')],
      [btn(`📤 Copy Sells: ${settings.copySells ? '✅' : '❌'}`, 'toggle:copySells')],
      [btn(`⚔️ Conflict Strategy: ${settings.conflictStrategy}`, 'set:conflictStrategy')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function timeExitsMenu(settings: any): InlineMarkup {
  return {
    inline_keyboard: [
      [btn(`⏱ Max Hold Time: ${settings.maxHoldTimeHours || 'OFF'}h`, 'set:maxHoldTimeHours')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function keywordsMenu(settings: any): InlineMarkup {
  const bl = settings.blacklistKeywords || 'none';
  const wl = settings.whitelistKeywords || 'none';
  return {
    inline_keyboard: [
      [btn(`🚫 Blacklist: ${bl.length > 20 ? bl.slice(0, 20) + '...' : bl}`, 'set:blacklistKeywords')],
      [btn(`✅ Whitelist: ${wl.length > 20 ? wl.slice(0, 20) + '...' : wl}`, 'set:whitelistKeywords')],
      [btn('⬅️ Back', 'menu:settings')],
    ],
  };
}

export function conflictStrategyMenu(): InlineMarkup {
  return {
    inline_keyboard: [
      [btn('🥇 First Signal Wins', 'conflict:first')],
      [btn('⏭ Skip Conflicts', 'conflict:skip')],
      [btn('👥 Majority Rules', 'conflict:majority')],
      [btn('💎 Highest Allocation', 'conflict:highest_allocation')],
      [btn('⬅️ Back', 'settings:execution')],
    ],
  };
}

export function tradingMenu(isRunning: boolean, isDryRun: boolean): InlineMarkup {
  const buttons: InlineButton[][] = [];

  if (isRunning) {
    buttons.push([btn('⏹ Stop Trading', 'trading:stop')]);
  } else {
    buttons.push([btn('▶️ Start Trading', 'trading:start')]);
  }

  buttons.push([btn(`🧪 Dry Run: ${isDryRun ? '✅ ON' : '❌ OFF'}`, 'toggle:dryRun')]);
  buttons.push([btn('⬅️ Back', 'menu:main')]);

  return { inline_keyboard: buttons };
}

export function positionsMenu(hasPositions: boolean): InlineMarkup {
  const buttons: InlineButton[][] = [];
  if (hasPositions) {
    buttons.push([btn('📋 View All', 'positions:list')]);
    buttons.push([btn('🔴 Sell Position', 'positions:sell_list'), btn('🔴 Sell All', 'positions:sell_all')]);
  }
  buttons.push([btn('⬅️ Back', 'menu:main')]);
  return { inline_keyboard: buttons };
}

export function confirmMenu(action: string): InlineMarkup {
  return {
    inline_keyboard: [
      [btn('✅ Yes, confirm', `confirm:${action}`), btn('❌ Cancel', 'menu:main')],
    ],
  };
}

export function backButton(target: string): InlineMarkup {
  return {
    inline_keyboard: [[btn('⬅️ Back', target)]],
  };
}
