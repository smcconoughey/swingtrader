#!/bin/bash
# Runs the bot and prevents macOS from sleeping while it's active.
# Uses caffeinate -i (prevent idle sleep) + -s (prevent system sleep on AC power).
# The bot process is the child — when it exits, caffeinate exits too.

cd "$(dirname "$0")"
npm install

echo ""
echo "Starting bot with caffeinate (prevents sleep while running)..."
echo "Press Ctrl+C to stop."
echo ""

caffeinate -is node bot.js
