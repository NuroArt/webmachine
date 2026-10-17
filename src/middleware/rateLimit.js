'use strict';

const rateLimit = require('express-rate-limit');

/** Key by authenticated Telegram id when available, else by IP. */
const keyGenerator = (req) => req.telegramUser?.id || req.ip;

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } },
};

/** Reads: dashboard, build list, catalog. */
const readLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 120 });

/** Writes that do not call Claude: intake, invoice creation. */
const actionLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 40 });

/**
 * Generation is the expensive path: several Claude calls per request.
 * Tighter than anything else because each one costs real money.
 */
const buildLimiter = rateLimit({ ...base, windowMs: 600_000, limit: 6 });

/** Coarse protection on everything else. */
const globalLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 300 });

module.exports = { readLimiter, actionLimiter, buildLimiter, globalLimiter };
