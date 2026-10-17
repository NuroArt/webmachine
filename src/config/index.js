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
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: num('CLAUDE_MAX_TOKENS', 8000),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    apiBase: 'https://api.telegram.org',
    miniAppUrl: process.env.MINI_APP_URL || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    opsChannelId: process.env.OPS_CHANNEL_ID || '',
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

if (config.isProd) {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is required in production');
  if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is required in production');
  if (!config.telegram.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is required in production');
  if (config.auth.allowDevAuth) throw new Error('ALLOW_DEV_AUTH must be false in production');
}

module.exports = config;
