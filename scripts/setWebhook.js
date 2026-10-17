#!/usr/bin/env node
'use strict';

/**
 * Registers the Telegram webhook and the command list.
 *   npm run set-webhook
 *   npm run set-webhook -- --delete
 *   npm run set-webhook -- --info
 */

const config = require('../src/config');
const bot = require('../src/telegram/bot');

async function main() {
  if (process.argv.includes('--info')) {
    console.log(JSON.stringify(await bot.getWebhookInfo(), null, 2));
    return;
  }

  if (process.argv.includes('--delete')) {
    await bot.deleteWebhook();
    console.log('Webhook deleted.');
    return;
  }

  if (!config.telegram.publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set');
  if (!config.telegram.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set');

  const me = await bot.getMe();
  const url = `${config.telegram.publicBaseUrl.replace(/\/+$/, '')}/webhook/telegram`;

  await bot.setWebhook(url, config.telegram.webhookSecret);
  await bot.setMyCommands();

  console.log(`Webhook set for @${me.username}`);
  console.log(`  url: ${url}`);
  console.log('Commands registered.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
