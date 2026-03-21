#!/bin/bash

# Polybot Start Script
# Keeps Mac awake and runs the bot

cd /Users/adialia/Desktop/Polybot

# Kill any existing bot process
pkill -f "tsx src/bot.ts" 2>/dev/null

echo "Starting Polybot..."
echo "==================="
echo ""
echo "Mac will stay awake (caffeinate enabled)"
echo "Dashboard: http://localhost:8888"
echo "Logs: tail -f bot.log"
echo ""
echo "To stop: ./stop.sh or pkill -f 'tsx src/bot.ts'"
echo ""

# Start bot with caffeinate (prevents sleep)
caffeinate -s npx tsx src/bot.ts
