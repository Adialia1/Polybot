#!/bin/bash

# Polybot Start Script
cd "$(dirname "$0")"

pkill -f "tsx src/bot.ts" 2>/dev/null

mkdir -p logs
ERROR_LOG="logs/errors-$(date +%Y-%m-%d).log"

echo "Starting Polybot..."
echo "==================="
echo ""
echo "Mac will stay awake (caffeinate enabled)"
echo "Dashboard: http://localhost:8888"
echo "Error log: $ERROR_LOG"
echo ""
echo "To stop: ./stop.sh or pkill -f 'tsx src/bot.ts'"
echo ""

# Terminal gets everything, error log gets only errors/failures
caffeinate -s npx tsx src/bot.ts 2>&1 | tee >(grep -E "❌|ERROR|error|FAILED|failed|AutoSell|not enough|invalid signature|SKIPPED" >> "$ERROR_LOG")
