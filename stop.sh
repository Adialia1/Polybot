#!/bin/bash

# Polybot Stop Script

echo "Stopping Polybot..."
pkill -f "tsx src/bot.ts" 2>/dev/null
pkill -f "caffeinate" 2>/dev/null
echo "Bot stopped."
