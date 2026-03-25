# Polybot Multi-User Telegram Bot - Implementation Plan

## Overview
Transform Polybot from a single-user CLI bot into a multi-user Telegram bot where each user can:
- Connect their Polymarket wallet (private key + wallet address)
- Configure their own trading settings via Telegram buttons
- Follow different trader wallets independently
- Manage risk settings (slippage, caps, stop-loss, take-profit, etc.)

## Architecture Changes

### 1. User Database (`src/db/userDb.ts`)
- SQLite database (via `better-sqlite3`) for persistent multi-user storage
- Tables: `users`, `user_wallets`, `user_settings`, `user_tracked_wallets`, `user_positions`, `user_trades`
- Each user identified by Telegram chat ID
- Encrypted private key storage (AES-256-GCM with master key from env)

### 2. Telegram Bot Rewrite (`src/telegram/`)
- **bot.ts** - Main Telegram bot with callback query routing
- **menus.ts** - Inline keyboard menu builders
- **handlers/** - Command and callback handlers:
  - `start.ts` - /start welcome + main menu
  - `wallet.ts` - Connect/disconnect/view wallets
  - `follow.ts` - Add/remove/list tracked wallets
  - `settings.ts` - Trading settings (slippage, caps, sizing, risk)
  - `positions.ts` - View positions, manual sell
  - `stats.ts` - Trading stats and P&L
  - `trading.ts` - Start/stop/pause trading

### 3. Per-User Bot Instances (`src/services/userBotManager.ts`)
- Manages a lightweight bot instance per active user
- Each instance runs its own TradeMonitor, Trader, RiskManager
- Lazy initialization (only when user starts trading)
- Graceful shutdown per user

### 4. Menu Flow
```
/start → Main Menu
  ├── 🔑 Wallets → Connect Wallet | View Wallets | Disconnect
  ├── 👁 Follow Traders → Add Wallet | List | Remove
  ├── ⚙️ Settings
  │     ├── Position Sizing → Account Size | Max Position | Min Trade | Max %
  │     ├── Risk Management → Stop Loss | Take Profit | Trailing Stop | Daily Loss Limit
  │     ├── Trade Filters → Min/Max Probability | Blacklist | Whitelist
  │     ├── Execution → Slippage | Copy Sells | Conflict Strategy
  │     └── Time Exits → Max Hold Time
  ├── 📊 Positions → List | Sell Position | Sell All
  ├── 📈 Stats → Overview | Per-Trader | Reset
  ├── ▶️ Start Trading / ⏸ Pause / ⏹ Stop
  └── ❓ Help
```

## Implementation Steps

1. Add dependencies (better-sqlite3, encryption)
2. Create database schema and UserDb class
3. Build Telegram menu system with inline keyboards
4. Implement wallet connection flow (encrypted storage)
5. Implement settings management via Telegram
6. Create UserBotManager for per-user bot instances
7. Wire everything together
8. Update config for multi-user mode
