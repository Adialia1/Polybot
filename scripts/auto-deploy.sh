#!/bin/bash
# Auto-deploy: polls git every 30s, pulls new changes, rebuilds and restarts the bot
# Usage: ./scripts/auto-deploy.sh

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
BOT_PID=""

echo "=== Polybot Auto-Deploy ==="
echo "Directory: $PROJECT_DIR"
echo "Watching for git changes every 30s..."
echo ""

# Build and start the bot
start_bot() {
  echo "[Deploy] Building..."
  npm run build 2>&1 | tail -3

  echo "[Deploy] Starting bot..."
  npm start &
  BOT_PID=$!
  echo "[Deploy] Bot started (PID: $BOT_PID)"
}

# Stop the bot gracefully
stop_bot() {
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[Deploy] Stopping bot (PID: $BOT_PID)..."
    kill "$BOT_PID" 2>/dev/null
    wait "$BOT_PID" 2>/dev/null
    echo "[Deploy] Bot stopped"
  fi
}

# Cleanup on exit
cleanup() {
  echo ""
  echo "[Deploy] Shutting down..."
  stop_bot
  exit 0
}
trap cleanup SIGINT SIGTERM

# Initial build and start
start_bot

# Poll loop
while true; do
  sleep 30

  # Fetch latest from remote
  git fetch origin main --quiet 2>/dev/null

  # Check if remote is ahead of local
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo ""
    echo "[Deploy] ==============================="
    echo "[Deploy] New changes detected!"
    echo "[Deploy] $LOCAL -> $REMOTE"
    echo "[Deploy] ==============================="

    # Pull changes
    git pull origin main --quiet

    # Stop, rebuild, restart
    stop_bot
    sleep 2
    start_bot

    echo "[Deploy] ==============================="
    echo "[Deploy] Redeployed successfully!"
    echo "[Deploy] ==============================="
    echo ""
  fi
done
