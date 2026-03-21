#!/bin/bash
# Auto-deploy: polls git every 30s, pulls new changes, rebuilds and restarts the bot
# If build fails → rolls back to last working version and keeps running
# Usage: ./scripts/auto-deploy.sh

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
BOT_PID=""
LAST_GOOD_COMMIT=""

echo "=== Polybot Auto-Deploy ==="
echo "Directory: $PROJECT_DIR"
echo "Watching for git changes every 30s..."
echo ""

# Build the project, return 0 on success, 1 on failure
build() {
  echo "[Deploy] Building..."
  if npm run build 2>&1 | tail -5; then
    echo "[Deploy] Build succeeded"
    return 0
  else
    echo "[Deploy] ❌ BUILD FAILED"
    return 1
  fi
}

# Start the bot process
start_bot() {
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

# Rollback to last known good commit
rollback() {
  if [ -n "$LAST_GOOD_COMMIT" ]; then
    echo "[Deploy] ⚠️  Rolling back to last working version: ${LAST_GOOD_COMMIT:0:8}"
    git checkout "$LAST_GOOD_COMMIT" --quiet 2>/dev/null
    build
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
if build; then
  LAST_GOOD_COMMIT=$(git rev-parse HEAD)
  start_bot
else
  echo "[Deploy] ❌ Initial build failed! Fix the code and try again."
  exit 1
fi

# Poll loop
while true; do
  sleep 30

  # Check if bot process crashed — restart it
  if [ -n "$BOT_PID" ] && ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[Deploy] ⚠️  Bot crashed! Restarting..."
    start_bot
  fi

  # Fetch latest from remote
  git fetch origin main --quiet 2>/dev/null

  # Check if remote is ahead of local
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo ""
    echo "[Deploy] ==============================="
    echo "[Deploy] New changes detected!"
    echo "[Deploy] ${LOCAL:0:8} -> ${REMOTE:0:8}"
    echo "[Deploy] ==============================="

    # Pull changes
    git pull origin main --quiet

    # Try to build
    if build; then
      # Build succeeded — stop old bot, start new one
      LAST_GOOD_COMMIT=$(git rev-parse HEAD)
      stop_bot
      sleep 2
      start_bot

      echo "[Deploy] ==============================="
      echo "[Deploy] ✅ Redeployed successfully!"
      echo "[Deploy] ==============================="
    else
      # Build failed — rollback and keep old bot running
      echo "[Deploy] ==============================="
      echo "[Deploy] ❌ Build failed! Keeping old version running."
      echo "[Deploy] ==============================="
      rollback
      # Bot is still running on old code, no restart needed
    fi
    echo ""
  fi
done
