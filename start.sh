#!/bin/bash
cd "$(dirname "$0")"
npm install

if [ "$1" = "bg" ]; then
  # Background mode with pm2 (survives terminal close, auto-restarts)
  if ! command -v pm2 &> /dev/null; then
    echo "Installing pm2 globally for background/daemon mode..."
    npm install -g pm2
  fi
  pm2 start bot.js --name swingers --cron-restart="*/30 * * * *"
  pm2 save
  echo ""
  echo "Bot running in background. Commands:"
  echo "  pm2 logs swingers    — view live logs"
  echo "  pm2 stop swingers    — stop the bot"
  echo "  pm2 restart swingers — restart the bot"
  echo "  pm2 delete swingers  — remove from pm2"
else
  # Foreground mode
  node bot.js
fi
