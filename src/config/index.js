'use strict';

require('dotenv').config();

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`);
  return n;
}

/**
 * Reads a secret and strips surrounding whitespace.
 *
 * Railway's Raw Editor, and every "copy the token" flow, routinely leave a
 * trailing newline or space. The Bot API tolerates it, so sending messages
 * keeps working, but the bot token is also the HMAC key for Mini App
 * initData. One invisible character there turns every initData check into
 * "signature is invalid" while everything else looks healthy.
 */
function secret(name) {
  return String(process.env[name] || '').trim();
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num('PORT', 8080),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  mongoUri: req('MONGODB_URI', 'mongodb://127.0.0.1:27017/webmachine'),

  anthropic: {
    apiKey: secret('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: num('CLAUDE_MAX_TOKENS', 8000),
  },

  telegram: {
    botToken: secret('TELEGRAM_BOT_TOKEN'),
    webhookSecret: secret('TELEGRAM_WEBHOOK_SECRET'),
    apiBase: 'https://api.telegram.org',
    miniAppUrl: secret('MINI_APP_URL').replace(/\/+$/, ''),
    publicBaseUrl: secret('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    opsChannelId: secret('OPS_CHANNEL_ID'),
  },

  pricing: {
    site: num('PRICE_SITE_STARS', 1500),
    funnel: num('PRICE_FUNNEL_STARS', 3800),
  },

  build: {
    freeBuildsPerDay: num('FREE_BUILDS_PER_DAY', 1),
    maxPagesPerBuild: num('MAX_PAGES_PER_BUILD', 6),
    dailyUsdCap: num('DAILY_USD_CAP', 50),
    generationTimeoutMs: num('GENERATION_TIMEOUT_MS', 180000),
  },

  auth: {
    initDataMaxAgeSeconds: num('INITDATA_MAX_AGE_SECONDS', 3600),
    allowDevAuth: bool('ALLOW_DEV_AUTH', false),
  },
};

config.isProd = config.env === 'production';

/**
 * The numeric half of the bot token, before the colon. It is the bot's public
 * id, not a secret: it appears in every t.me deep link. Surfacing it on
 * /health is the only way to confirm from outside that the running service
 * holds the token for the bot you think it does, which is the difference
 * between "initData is broken" and "that is a different bot".
 */
config.telegram.botId = config.telegram.botToken.split(':')[0] || null;

if (config.isProd) {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is required in production');
  if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is required in production');
  if (!config.telegram.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is required in production');
  if (config.auth.allowDevAuth) throw new Error('ALLOW_DEV_AUTH must be false in production');
}

module.exports = config;
