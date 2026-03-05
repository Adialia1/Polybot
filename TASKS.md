# Polybot Enhancement Tasks

## High Priority

### 1. Telegram Notifications
- [ ] Create TelegramNotifier service
- [ ] Send alerts on: trade executed, trade failed, stop loss triggered, take profit triggered
- [ ] Send daily summary (positions, P&L, trades count)
- [ ] Config: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env

### 2. Daily Loss Limit ✅
- [x] Track daily P&L in StateManager
- [x] Stop trading if daily loss exceeds limit (e.g., $10 or 30%)
- [x] Reset at midnight UTC
- [x] Config: DAILY_LOSS_LIMIT in .env

### 3. Per-Trader Allocation ✅
- [x] Add `allocation` field to wallet config (0-100%)
- [x] Scale position size by trader's allocation
- [x] Example: RN1 gets 60%, tripping gets 40%

### 4. Market Blacklist
- [ ] Add BLACKLIST_KEYWORDS in config (e.g., "NBA", "NFL", "soccer")
- [ ] Skip trades matching blacklisted keywords in title
- [ ] Support regex patterns

### 5. Retry Logic for Failed Orders
- [ ] Retry failed orders up to 3 times with exponential backoff
- [ ] Track retry count in order state
- [ ] Give up after max retries

## Medium Priority

### 6. Performance Tracking per Trader
- [ ] Track P&L per trader in StateManager
- [ ] Track win rate per trader
- [ ] Track average hold time
- [ ] Add to status command output

### 7. Trailing Stop Loss
- [ ] Track highest price reached for each position
- [ ] Sell if price drops X% from peak (e.g., 15%)
- [ ] More sophisticated than fixed stop loss

### 8. Max Open Positions Limit ✅
- [x] Config: MAX_OPEN_POSITIONS (e.g., 10)
- [x] Skip new BUY signals if at limit
- [x] Still allow SELL signals

### 9. Conflict Resolution
- [ ] Detect when tracked traders make opposite trades on same market
- [ ] Options: follow majority, follow highest allocation trader, skip conflicting trades
- [ ] Config: CONFLICT_STRATEGY

### 10. Health Check Endpoint
- [ ] Simple HTTP server on configurable port
- [ ] /health returns bot status, positions count, last trade time
- [ ] Useful for monitoring with uptime services

## Lower Priority

### 11. Buy-Only Mode
- [ ] Config: COPY_SELLS=false to ignore sell signals
- [ ] Manage exits yourself with stop loss / take profit

### 12. Time-Based Exits
- [ ] Config: MAX_HOLD_TIME_HOURS (e.g., 48)
- [ ] Auto-sell positions held longer than limit

### 13. Market Whitelist
- [ ] Config: WHITELIST_KEYWORDS (e.g., "Bitcoin", "Trump", "Election")
- [ ] Only copy trades matching whitelisted keywords

### 14. Web Dashboard
- [ ] Simple Express server with React/HTML dashboard
- [ ] Show positions, recent trades, P&L chart
- [ ] Manual controls (pause bot, force sell)

### 15. Config File Support
- [ ] Load settings from config.json instead of just .env
- [ ] Easier to manage complex settings
- [ ] Hot-reload config without restart

---

## Implementation Order (Parallel Batches)

### Batch 1 (No dependencies between these) ✅ DONE
- [x] 1. Telegram Notifications
- [x] 4. Market Blacklist
- [x] 5. Retry Logic

### Batch 2 ✅ DONE
- [x] 2. Daily Loss Limit
- [x] 3. Per-Trader Allocation
- [x] 8. Max Open Positions

### Batch 3
- [ ] 6. Performance Tracking
- [ ] 7. Trailing Stop Loss
- [ ] 10. Health Check Endpoint

### Batch 4
- [ ] 9. Conflict Resolution
- [ ] 11. Buy-Only Mode
- [ ] 12. Time-Based Exits

### Batch 5
- [ ] 13. Market Whitelist
- [ ] 14. Web Dashboard
- [ ] 15. Config File Support
