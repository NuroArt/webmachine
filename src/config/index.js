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

/**
 * The public product name, on every surface a user sees: the Telegram /start
 * header, the Mini App button, the README inside the delivered .zip, and the
 * Discord embeds.
 *
 * `WebMachine` stays the name of the repo, the package and the logs. It was
 * previously hardcoded in four separate files, which is how a rename leaves
 * one of them behind.
 */
const BRAND_NAME = process.env.BRAND_NAME || 'FivePageBot';

const config = {
  env: process.env.NODE_ENV || 'development',
  brandName: BRAND_NAME,
  port: num('PORT', 8080),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Trimmed for the same reason the secrets above are.
   *
   * A connection string pasted into Railway's editor routinely carries a
   * trailing newline. Mongo's parser does not tolerate it the way the Bot API
   * tolerates a stray byte on a token: the driver reports "bad auth" or an
   * invalid scheme, which reads as a wrong password and sends you to rotate
   * credentials that were never the problem.
   */
  mongoUri: String(req('MONGODB_URI', 'mongodb://127.0.0.1:27017/webmachine')).trim(),

  anthropic: {
    apiKey: secret('ANTHROPIC_API_KEY'),
    // A wrong model id fails as a 400 on the first call of every build, after
    // the buyer has already paid. Keep this pointed at a model that exists.
    model: secret('CLAUDE_MODEL') || 'claude-sonnet-5-5',
    maxTokens: num('CLAUDE_MAX_TOKENS', 8000),
  },

  telegram: {
    botToken: secret('TELEGRAM_BOT_TOKEN'),
    webhookSecret: secret('TELEGRAM_WEBHOOK_SECRET'),
    apiBase: 'https://api.telegram.org',
    miniAppUrl: secret('MINI_APP_URL').replace(/\/+$/, ''),
    publicBaseUrl: secret('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    opsChannelId: secret('OPS_CHANNEL_ID'),
    /**
     * Bot username without the @, e.g. "FivePageBot". The Discord adapter
     * links here to sell the paid tiers, since Stars only exist on Telegram.
     * Without it, Discord renders no upsell rather than a dead link.
     */
    botUsername: secret('TELEGRAM_BOT_USERNAME').replace(/^@/, ''),
  },

  /**
   * The Discord adapter. Ships free-tier only: there is no payment rail here,
   * because Discord has no arbitrary-amount invoice and no bot-callable
   * refund, and the instant-refund guarantee is load-bearing for the paid
   * products. Discord's job is acquisition; Telegram's is checkout.
   */
  discord: {
    botToken: secret('DISCORD_BOT_TOKEN'),
    applicationId: secret('DISCORD_APPLICATION_ID'),
    /** Optional: register commands to one guild for instant iteration. */
    devGuildId: secret('DISCORD_DEV_GUILD_ID'),
    enabled: bool('DISCORD_ENABLED', false),
    /** Overrides BRAND_NAME on Discord only. Normally left unset. */
    brandName: secret('DISCORD_BRAND_NAME') || BRAND_NAME,
  },

  /**
   * Served at /terms and /privacy from this same server, so Discord's
   * Terms of Service URL and Privacy Policy URL fields have somewhere real
   * to point without standing up another host.
   */
  legal: {
    entity: process.env.LEGAL_ENTITY || 'NuroWorks',
    /**
     * Optional. A privacy policy needs a way to reach a human, but the page
     * falls back to "contact us through the bot" rather than publishing an
     * address that was never meant to be public.
     */
    contactEmail: secret('LEGAL_CONTACT_EMAIL'),
    /** Bumped when the text changes materially. Shown on both pages. */
    updated: process.env.LEGAL_UPDATED || '2026-10-23',
  },

  pricing: {
    site: num('PRICE_SITE_STARS', 1500),
    funnel: num('PRICE_FUNNEL_STARS', 3800),
  },

  /**
   * Accounts exempt from the daily free-build limit.
   *
   * Comma-separated ids, on either platform. A bare number is read as
   * Telegram (consistent with every other id in the system); a Discord id
   * needs its prefix:
   *
   *   OWNER_IDS=8104424408,discord:1562303621473767426
   *
   * This exists so testing the product does not mean raising the limit for
   * everyone, which is the version of this that ends with a stranger
   * generating ten pages a day against your Anthropic credit. Owners are
   * exempt from the daily cap only — the one-build-at-a-time guard and the
   * daily spend breaker still apply, because those protect the service and
   * the wallet rather than rationing a free tier.
   */
  ownerIds: (process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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

// Fail at boot rather than at the first interaction: a Gateway client with no
// token logs in, fails, and retries forever while every slash command times
// out with "application did not respond".
if (config.discord.enabled) {
  if (!config.discord.botToken) throw new Error('DISCORD_BOT_TOKEN is required when DISCORD_ENABLED=true');
  if (!config.discord.applicationId) {
    throw new Error('DISCORD_APPLICATION_ID is required when DISCORD_ENABLED=true');
  }
  if (!config.telegram.publicBaseUrl) {
    // Discord delivers a preview link and a download fallback. Both are built
    // from PUBLIC_BASE_URL, and without it the bot can only attach a zip.
    throw new Error('PUBLIC_BASE_URL is required when DISCORD_ENABLED=true');
  }
}

module.exports = config;
