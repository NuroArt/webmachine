'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { Errors } = require('../utils/errors');

const API = () => `${config.telegram.apiBase}/bot${config.telegram.botToken}`;

/** Thin wrapper over the Bot API with uniform error handling. */
async function callTelegram(method, payload = {}) {
  if (!config.telegram.botToken) throw Errors.upstream('TELEGRAM_BOT_TOKEN is not configured');

  let res;
  try {
    res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error({ method, err: err.message }, 'Telegram request failed');
    throw Errors.upstream(`Telegram request failed: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    logger.error(
      { method, status: res.status, description: data.description },
      'Telegram API error'
    );
    throw Errors.upstream(`Telegram ${method} failed: ${data.description || res.status}`);
  }

  return data.result;
}

/**
 * Creates a Telegram Stars invoice link.
 *
 * Stars invoices use currency "XTR", an empty provider_token, and exactly one
 * price component whose `amount` is the Star count, not a minor unit.
 *
 * Stars is the only rail this service uses. Telegram requires Stars for
 * digital goods sold inside a bot or Mini App, and a non-Stars payment path
 * would hide the bot from every mobile user.
 */
async function createStarsInvoiceLink({ title, description, payload, starAmount }) {
  return callTelegram('createInvoiceLink', {
    title: String(title).slice(0, 32),
    description: String(description).slice(0, 255),
    payload: String(payload).slice(0, 128),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: String(title).slice(0, 32), amount: Math.floor(starAmount) }],
  });
}

/** Must be answered within 10 seconds or Telegram cancels the payment. */
async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  const payload = { pre_checkout_query_id: preCheckoutQueryId, ok };
  if (!ok && errorMessage) payload.error_message = String(errorMessage).slice(0, 255);
  return callTelegram('answerPreCheckoutQuery', payload);
}

async function sendMessage(chatId, text, extra = {}) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/**
 * Edits a message in place. Used for build progress: a generation takes about
 * a minute, and a message that visibly changes reads as working where a frozen
 * one reads as broken.
 *
 * Never throws. A failed progress edit must not abort a build in flight, and
 * Telegram rejects an edit whose text is byte-identical to what is already
 * there.
 */
async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    return await callTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch {
    return null;
  }
}

/** Uploads a file. Node 20's global FormData and Blob handle the multipart body. */
async function sendDocument(chatId, buffer, filename, caption, extra = {}) {
  if (!config.telegram.botToken) throw Errors.upstream('TELEGRAM_BOT_TOKEN is not configured');

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', String(caption).slice(0, 1024));
    form.append('parse_mode', 'HTML');
  }
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  form.append('document', new Blob([buffer], { type: 'application/zip' }), filename);

  let res;
  try {
    res = await fetch(`${API()}/sendDocument`, { method: 'POST', body: form });
  } catch (err) {
    logger.error({ err: err.message }, 'sendDocument request failed');
    throw Errors.upstream(`Telegram sendDocument failed: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    logger.error({ status: res.status, description: data.description }, 'sendDocument API error');
    throw Errors.upstream(`Telegram sendDocument failed: ${data.description || res.status}`);
  }

  return data.result;
}

/** Refunds a Stars payment. Telegram allows this within 21 days. */
async function refundStarPayment(userId, telegramPaymentChargeId) {
  return callTelegram('refundStarPayment', {
    user_id: Number(userId),
    telegram_payment_charge_id: telegramPaymentChargeId,
  });
}

async function setWebhook(url, secretToken) {
  return callTelegram('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
    drop_pending_updates: false,
  });
}

async function deleteWebhook() {
  return callTelegram('deleteWebhook', { drop_pending_updates: false });
}

async function getWebhookInfo() {
  return callTelegram('getWebhookInfo');
}

async function getMe() {
  return callTelegram('getMe');
}

async function setMyCommands() {
  return callTelegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'Build a website or funnel' },
      { command: 'builds', description: 'Your past builds' },
      { command: 'pricing', description: 'What things cost' },
      { command: 'invite', description: 'Your referral link' },
      { command: 'refund', description: 'Instant refund, no questions' },
      { command: 'forget', description: 'Delete your builds and details' },
      { command: 'help', description: 'How this works' },
    ],
  });
}

/** The keyboard that launches the Mini App. */
function miniAppKeyboard(label = `Open ${config.brandName}`) {
  if (!config.telegram.miniAppUrl) return undefined;
  return { inline_keyboard: [[{ text: label, web_app: { url: config.telegram.miniAppUrl } }]] };
}

/**
 * Posts to the private ops channel. Never throws and never blocks: an ops
 * alert failing must not take a paid build down with it.
 */
async function ops(text) {
  if (!config.telegram.opsChannelId) return;
  try {
    await sendMessage(config.telegram.opsChannelId, text);
  } catch {
    /* swallowed by design */
  }
}

module.exports = {
  callTelegram,
  createStarsInvoiceLink,
  answerPreCheckoutQuery,
  sendMessage,
  editMessageText,
  sendDocument,
  refundStarPayment,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  getMe,
  setMyCommands,
  miniAppKeyboard,
  ops,
};
