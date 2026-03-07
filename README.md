# Polybot - Polymarket Trade Copier

[![CI](https://github.com/Adialia1/polybot/actions/workflows/ci.yml/badge.svg)](https://github.com/Adialia1/polybot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Adialia1/polybot/actions/workflows/codeql.yml/badge.svg)](https://github.com/Adialia1/polybot/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue)](https://www.typescriptlang.org/)

A sophisticated trade copying bot for Polymarket that tracks successful traders and automatically copies their trades.

> ⚠️ **WARNING:** This bot involves real money and automated trading. **USE AT YOUR OWN RISK.** The authors are not responsible for any financial losses. Always start with `DRY_RUN=true` and test thoroughly before using real funds.

## Features

### Core Trading
- **Real-time trade monitoring** - Polls trader activity every second
- **Smart position sizing** - Scales trades based on your account size and trader's percentage
- **Automatic order execution** - Places limit orders via Polymarket CLOB API
- **Crash recovery** - Persists state to disk, resumes after restart
- **Order queue** - Handles multiple signals with deduplication

### Risk Management
- **Stop Loss** - Auto-sell positions at configurable loss threshold (default: -25%)
- **Take Profit** - Auto-sell positions at configurable profit threshold (default: +100%)
- **Trailing Stop** - Sell when price drops X% from peak (e.g., 15%)
- **Daily Loss Limit** - Stop trading if daily losses exceed limit
- **Max Open Positions** - Limit concurrent positions
- **Probability Filter** - Skip trades outside probability range (e.g., 5%-95%)
- **Max Spread Filter** - Skip trades with high bid/ask spread

### Trade Filtering
- **Market Blacklist** - Skip markets matching keywords (e.g., "NBA", "NFL")
- **Market Whitelist** - Only trade markets matching keywords (e.g., "Bitcoin", "Trump")
- **Buy-Only Mode** - Ignore sell signals, manage exits yourself

### Multi-Trader Support
- **Per-Trader Allocation** - Scale position size by trader (e.g., RN1: 60%, tripping: 40%)
- **Conflict Resolution** - Handle opposite trades from different traders
- **Performance Tracking** - Track P&L, win rate, avg hold time per trader

### Automation
- **Time-Based Exits** - Auto-sell positions held longer than X hours
- **Position Reconciliation** - Detect and handle orphaned positions
- **Retry Logic** - Retry failed orders with exponential backoff

### Monitoring & Control
- **Telegram Notifications** - Alerts for trades, stops, daily summaries
- **Telegram Bot Commands** - Check status, positions, and stats via chat commands
- **Health Check Endpoint** - HTTP endpoint for uptime monitoring
- **Web Dashboard** - Browser UI with positions, trades, P&L, manual controls
- **Config Hot-Reload** - Update settings without restarting

---

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd polybot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

---

## Configuration

### Required Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your wallet private key | `0xabc123...` |
| `FUNDER_ADDRESS` | Your Polymarket proxy wallet address | `0xc1B677...` |
| `POLY_API_KEY` | Polymarket API key (derived from wallet) | `39804ff1-...` |
| `POLY_API_SECRET` | Polymarket API secret | `rshOue6D...` |
| `POLY_PASSPHRASE` | Polymarket API passphrase | `22668754...` |

### Wallet Tracking

| Variable | Description | Default |
|----------|-------------|---------|
| `TRACK_WALLETS` | JSON array of wallet objects to track | Required |

**Format:**
```bash
TRACK_WALLETS=[{"address":"0xWallet1","alias":"Trader1","enabled":true,"allocation":60},{"address":"0xWallet2","alias":"Trader2","enabled":true,"allocation":40}]
```

**Example (Single Trader):**
```bash
TRACK_WALLETS=[{"address":"0x2005d16a84ceefa912d4e380cd32e7ff827875ea","alias":"RN1","enabled":true,"allocation":100}]
```

**Example (Multiple Traders):**
```bash
TRACK_WALLETS=[{"address":"0x2005d16a...","alias":"RN1","enabled":true,"allocation":50},{"address":"0xabc123...","alias":"Trader2","enabled":true,"allocation":50}]
```

**Note:** Allocation percentages should sum to 100.

### Position Sizing

| Variable | Description | Default |
|----------|-------------|---------|
| `USER_ACCOUNT_SIZE` | Your total account size in USD | `100` |
| `MAX_POSITION_SIZE` | Maximum USD per trade | `10` |
| `MIN_TRADE_SIZE` | Minimum USD per trade | `1` |
| `MAX_PERCENTAGE_PER_TRADE` | Max % of account per trade | `10` |

### Risk Management

| Variable | Description | Default |
|----------|-------------|---------|
| `STOP_LOSS_PERCENT` | Stop loss threshold (negative) | `-25` |
| `TAKE_PROFIT_PERCENT` | Take profit threshold | `100` |
| `TRAILING_STOP_PERCENT` | Trailing stop from peak | `0` (disabled) |
| `DAILY_LOSS_LIMIT` | Max daily loss in USD | `0` (disabled) |
| `MAX_OPEN_POSITIONS` | Max concurrent positions | `0` (unlimited) |
| `MAX_HOLD_TIME_HOURS` | Auto-sell after X hours | `0` (disabled) |

### Trade Filtering

| Variable | Description | Default |
|----------|-------------|---------|
| `MIN_PROBABILITY` | Minimum probability to trade | `0.05` (5%) |
| `MAX_PROBABILITY` | Maximum probability to trade | `0.95` (95%) |
| `MAX_SPREAD` | Maximum bid/ask spread | `0.10` (10%) |
| `BLACKLIST_KEYWORDS` | Skip markets with these keywords | Empty |
| `WHITELIST_KEYWORDS` | Only trade markets with these keywords | Empty |

**Example:**
```bash
BLACKLIST_KEYWORDS=NBA,NFL,soccer,hockey
WHITELIST_KEYWORDS=Bitcoin,Trump,Election
```

### Trading Modes

| Variable | Description | Default |
|----------|-------------|---------|
| `DRY_RUN` | Simulate trades without executing | `true` |
| `COPY_SELLS` | Copy sell signals from traders | `true` |
| `CONFLICT_STRATEGY` | How to handle conflicting signals | `first` |

**Conflict Strategies:**
- `first` - Follow the first signal received
- `skip` - Skip conflicting trades entirely
- `majority` - Follow the majority direction
- `highest_allocation` - Follow the trader with highest allocation

### Retry Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_RETRIES` | Max retry attempts for failed orders | `3` |
| `RETRY_DELAY_MS` | Base delay between retries (ms) | `2000` |
| `COPY_DELAY_MS` | Delay before copying a trade (ms) | `0` |

### Telegram Notifications

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | Empty |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Empty |

**Setup:**
1. Message @BotFather on Telegram, create a bot, get the token
2. Message @userinfobot to get your chat ID
3. Add both to your `.env`

**Available Commands:**
- `/status` - Check if bot is active and uptime
- `/positions` - Show all open positions
- `/stats` - Show trading statistics (trades, success rate, volume)
- `/help` - Show available commands

### Health Check Endpoint

| Variable | Description | Default |
|----------|-------------|---------|
| `HEALTH_CHECK_ENABLED` | Enable HTTP health endpoint | `false` |
| `HEALTH_CHECK_PORT` | Port for health server | `3000` |

**Endpoints:**
- `GET /` - Simple status message
- `GET /health` - JSON with bot status, positions, P&L
- `GET /positions` - Current positions list

### Web Dashboard

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHBOARD_ENABLED` | Enable web dashboard | `false` |
| `DASHBOARD_PORT` | Port for dashboard | `8080` |

**Features:**
- View all positions with real-time P&L
- View recent trades
- Per-trader performance stats
- Pause/Resume bot
- Force sell positions
- Auto-refresh every 10 seconds

### Polling & Timing

| Variable | Description | Default |
|----------|-------------|---------|
| `POLLING_INTERVAL_MS` | How often to check for new trades | `1000` |
| `TRAILING_STOP_CHECK_INTERVAL_MS` | How often to check trailing stops | `60000` |
| `RISK_CHECK_INTERVAL_MS` | How often to check stop loss/take profit | `30000` |

---

## Config File (Alternative to .env)

Instead of `.env`, you can use `data/config.json`:

```json
{
  "dryRun": false,
  "maxPositionSize": 10,
  "userAccountSize": 100,
  "trackWallets": [
    { "address": "0x2005d16a84ceefa912d4e380cd32e7ff827875ea", "alias": "RN1", "allocation": 60 },
    { "address": "0xabc123...", "alias": "tripping", "allocation": 40 }
  ],
  "blacklistKeywords": ["NBA", "NFL"],
  "whitelistKeywords": ["Bitcoin", "Trump"],
  "dailyLossLimit": 50,
  "maxOpenPositions": 10,
  "trailingStopPercent": 15,
  "maxHoldTimeHours": 48,
  "copySells": true,
  "conflictStrategy": "majority"
}
```

**Hot-Reload:** Most settings update automatically when you edit config.json (no restart needed).

See `data/config.example.json` for a complete template.

---

## Usage

### Start the Bot

**Using convenience scripts (macOS/Linux):**
```bash
# Start with caffeinate (prevents Mac from sleeping)
./start.sh

# Stop the bot
./stop.sh
```

**Using npm:**
```bash
# Development (with hot-reload)
npm run bot

# Production
npm run build
npm start
```

**Note:** The `start.sh` script uses `caffeinate` to keep your Mac awake while the bot runs.

### Other Commands

```bash
# Check account balance
npm run check-balance

# View current positions
npm run positions

# View recent trades
npm run trades

# View bot status
npm run status

# Sell a specific position
npm run sell

# Find a market by keyword
npm run find-market

# Test a trade (small amount)
npm run test-trade

# Approve USDC spending
npm run approve
```

---

## Example .env File

```bash
# === REQUIRED ===
PRIVATE_KEY=0xYourPrivateKeyHere
FUNDER_ADDRESS=0xYourProxyWalletAddress
POLY_API_KEY=your-api-key
POLY_API_SECRET=your-api-secret
POLY_PASSPHRASE=your-passphrase

# === WALLETS TO TRACK ===
TRACK_WALLETS=[{"address":"0x2005d16a84ceefa912d4e380cd32e7ff827875ea","alias":"RN1","enabled":true,"allocation":100}]

# === POSITION SIZING ===
USER_ACCOUNT_SIZE=100
MAX_POSITION_SIZE=10
MIN_TRADE_SIZE=1

# === RISK MANAGEMENT ===
DRY_RUN=true
STOP_LOSS_PERCENT=-25
TAKE_PROFIT_PERCENT=100
TRAILING_STOP_PERCENT=15
DAILY_LOSS_LIMIT=50
MAX_OPEN_POSITIONS=10
MAX_HOLD_TIME_HOURS=48

# === FILTERING ===
MIN_PROBABILITY=0.05
MAX_PROBABILITY=0.95
BLACKLIST_KEYWORDS=NBA,NFL,soccer
WHITELIST_KEYWORDS=
COPY_SELLS=true
CONFLICT_STRATEGY=first

# === RETRY ===
MAX_RETRIES=3
RETRY_DELAY_MS=2000

# === TELEGRAM ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# === MONITORING ===
HEALTH_CHECK_ENABLED=false
HEALTH_CHECK_PORT=3000
DASHBOARD_ENABLED=false
DASHBOARD_PORT=8080
```

---

## Architecture

```
polybot/
├── src/
│   ├── bot.ts                 # Main bot entry point
│   ├── config.ts              # Configuration loader
│   ├── index.ts               # CLI commands
│   ├── services/
│   │   ├── stateManager.ts    # Persistent state (positions, orders, stats)
│   │   ├── positionManager.ts # Position tracking and sync
│   │   ├── tradeMonitor.ts    # Polls traders for new trades
│   │   ├── trader.ts          # Executes trades via CLOB API
│   │   ├── orderQueue.ts      # Order queue with deduplication
│   │   ├── riskManager.ts     # Stop loss, take profit monitoring
│   │   ├── trailingStopMonitor.ts  # Trailing stop monitoring
│   │   ├── timeBasedExitMonitor.ts # Time-based exit monitoring
│   │   ├── positionReconciler.ts   # Orphaned position detection
│   │   ├── tradeFilter.ts     # Blacklist/whitelist filtering
│   │   ├── notifier.ts        # Telegram notifications
│   │   ├── healthCheck.ts     # HTTP health endpoint
│   │   ├── dashboard.ts       # Web dashboard
│   │   └── configLoader.ts    # Config file with hot-reload
│   ├── scripts/
│   │   ├── status.ts          # Status command
│   │   ├── sellPosition.ts    # Manual sell command
│   │   └── ...
│   └── types/
│       └── polymarket.ts      # TypeScript interfaces
├── data/
│   ├── state.json             # Persisted bot state
│   └── config.json            # Optional config file
└── .env                       # Environment variables
```

---

## State Persistence

The bot saves state to `data/state.json` every 30 seconds and on shutdown:

- **Positions** - Current positions with entry price, size, trader
- **Orders** - Recent order history (last 100)
- **Stats** - Total trades, volume, success rate
- **Daily P&L** - Cumulative profit/loss for today
- **Trader Stats** - Per-trader P&L, win rate, hold time
- **Last Seen Trades** - Timestamps to avoid duplicate processing

State survives crashes and restarts.

---

## How Trade Copying Works

1. **Monitor** - Polls each tracked wallet's activity every second
2. **Detect** - Identifies new BUY/SELL trades since last check
3. **Filter** - Applies probability, blacklist, whitelist, conflict checks
4. **Size** - Calculates position size based on trader's % and your limits
5. **Queue** - Adds order to queue with deduplication
6. **Execute** - Places limit order via Polymarket CLOB API
7. **Track** - Updates local position state
8. **Monitor** - Watches positions for stop loss, take profit, trailing stop

---

## Tips

1. **Start with DRY_RUN=true** to test without real trades
2. **Set conservative limits** initially (small position sizes, tight stops)
3. **Use Telegram notifications** to monitor while away
4. **Enable the dashboard** for easy monitoring and manual control
5. **Track multiple traders** with different allocations to diversify
6. **Use blacklist** to avoid sports/entertainment markets you don't understand
7. **Set daily loss limit** to prevent catastrophic losses

---

## Troubleshooting

### "Unauthorized" API Error
- Make sure you're using derived API credentials (not Builder API keys)
- Verify FUNDER_ADDRESS is your proxy wallet (not your main wallet)

### Positions Not Syncing
- Run `npm run positions` to check current positions
- The bot syncs with Polymarket API on startup

### Trades Not Copying
- Check if probability is within MIN/MAX range
- Check if market matches blacklist/whitelist
- Check if daily loss limit is exceeded
- Check if max open positions reached

### Bot Crashes
- State is auto-saved, restart will resume
- Check logs for error messages
- Verify API credentials are valid

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Disclaimer

**USE AT YOUR OWN RISK.** This bot involves real money and automated trading. The authors are not responsible for any financial losses. Always start with `DRY_RUN=true` and small amounts.

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

- **Issues:** [GitHub Issues](https://github.com/Adialia1/polybot/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Adialia1/polybot/discussions)
