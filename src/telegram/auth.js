'use strict';

const crypto = require('crypto');
const config = require('../config');
const { Errors } = require('../utils/errors');

/**
 * Validates Telegram Mini App `initData`.
 *
 * Telegram's scheme:
 *   secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
 *   hash       = HMAC_SHA256(key=secret_key, message=data_check_string)
 *
 * where data_check_string is every field except `hash`, sorted by key,
 * joined as "key=value" with newlines.
 *
 * @param {string} initData  Raw query-string from Telegram.WebApp.initData
 * @returns {{user: object, authDate: Date, queryId: string|null, startParam: string|null}}
 */
function verifyInitData(initData) {
  if (typeof initData !== 'string' || !initData) {
    throw Errors.unauthorized('initData is missing');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw Errors.unauthorized('initData has no hash');

  params.delete('hash');
  // `signature` is Telegram's newer Ed25519 field and is excluded from the
  // legacy HMAC check.
  params.delete('signature');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => [k, v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(config.telegram.botToken)
    .digest();

  const computed = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Constant-time compare; length mismatch is itself a failure.
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Errors.unauthorized('initData signature is invalid');
  }

  // Reject stale payloads so a captured initData cannot be replayed forever.
  const authDateRaw = params.get('auth_date');
  const authDate = new Date(Number(authDateRaw) * 1000);
  if (!authDateRaw || Number.isNaN(authDate.getTime())) {
    throw Errors.unauthorized('initData has no valid auth_date');
  }

  const ageSeconds = (Date.now() - authDate.getTime()) / 1000;
  if (ageSeconds > config.auth.initDataMaxAgeSeconds) {
    throw Errors.unauthorized('initData has expired. Reopen the app.');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw Errors.unauthorized('initData has no user');

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw Errors.unauthorized('initData user is not valid JSON');
  }

  if (!user || !user.id) throw Errors.unauthorized('initData user has no id');

  return {
    user: {
      id: String(user.id),
      username: user.username || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      languageCode: user.language_code || null,
      isPremium: Boolean(user.is_premium),
    },
    authDate,
    queryId: params.get('query_id'),
    startParam: params.get('start_param'),
  };
}

/**
 * Express middleware. Reads initData from the `X-Telegram-Init-Data` header or
 * the request body, and attaches `req.telegramUser`.
 */
function telegramAuth(req, res, next) {
  try {
    const initData =
      req.get('X-Telegram-Init-Data') ||
      req.body?.initData ||
      req.query?.initData;

    // Development escape hatch, hard-disabled in production by config checks.
    if (config.auth.allowDevAuth && !initData) {
      const devId = req.get('X-Dev-User-Id') || req.body?.userId;
      if (devId) {
        req.telegramUser = {
          id: String(devId),
          username: 'devuser',
          firstName: 'Dev',
          lastName: null,
          languageCode: 'en',
          isPremium: false,
        };
        req.startParam = req.body?.startParam || null;
        return next();
      }
    }

    const verified = verifyInitData(initData);
    req.telegramUser = verified.user;
    req.startParam = verified.startParam;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Guards the Telegram webhook using the secret token Telegram echoes back. */
function webhookAuth(req, res, next) {
  const token = req.get('X-Telegram-Bot-Api-Secret-Token');
  const expected = config.telegram.webhookSecret;

  if (!expected) return next(Errors.unauthorized('Webhook secret not configured'));
  if (!token) return next(Errors.unauthorized('Missing webhook secret token'));

  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(Errors.unauthorized('Invalid webhook secret token'));
  }

  return next();
}

module.exports = { verifyInitData, telegramAuth, webhookAuth };
