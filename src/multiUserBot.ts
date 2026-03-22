import 'dotenv/config';
import { TelegramTradingBot } from './telegram/bot.js';

async function main() {
  console.log('='.repeat(50));
  console.log('  Polybot - Multi-User Telegram Trading Bot');
  console.log('='.repeat(50));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required');
    console.error('Get a token from @BotFather on Telegram');
    process.exit(1);
  }

  const bot = new TelegramTradingBot(token);
  console.log('[Main] Telegram bot started. Send /start to your bot to begin.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Main] Shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[Main] Fatal error:', error);
  process.exit(1);
});
