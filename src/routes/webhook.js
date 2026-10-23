'use strict';

const express = require('express');

const { webhookAuth } = require('../telegram/auth');
const bot = require('../telegram/bot');
const config = require('../config');
const logger = require('../utils/logger');

const service = require('../build/service');
const User = require('../models/User');
const { PRODUCTS, PRODUCTS_BY_ID, usdApprox } = require('../catalog/products');

const router = express.Router();

/* ────────────────────────────────────────────────────────────
   THE WEBHOOK
   ──────────────────────────────────────────────────────────── */

/**
 * Two rules govern everything here:
 *
 * 1. Always answer 200 quickly. A non-200 makes Telegram retry the same update
 *    for hours, which turns one bad payment into a storm.
 * 2. Do the risky work AFTER responding, except for pre_checkout_query, which
 *    Telegram requires an answer to within 10 seconds.
 */
router.post('/telegram', webhookAuth, async (req, res) => {
  const update = req.body || {};

  if (update.pre_checkout_query) {
    await handlePreCheckout(update.pre_checkout_query).catch((err) =>
      logger.error({ err: err.message }, 'Pre-checkout handling failed')
    );
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  setImmediate(() => {
    processUpdate(update).catch((err) =>
      logger.error({ err: err.message, updateId: update.update_id }, 'Webhook processing failed')
    );
  });
});

router.get('/telegram', (req, res) => {
  res.json({ ok: true, webhook: 'ready', configured: Boolean(config.telegram.webhookSecret) });
});

/* ────────────────────────────────────────────────────────────
   PAYMENTS
   ──────────────────────────────────────────────────────────── */

/**
 * The last safe moment to reject. After this, money moves.
 *
 * The price is re-derived from the catalog rather than trusted from the
 * invoice, and the payer is checked against the user id baked into the
 * payload. Together those stop a tampered invoice from underpaying and stop
 * one account from paying another's invoice.
 */
async function handlePreCheckout(query) {
  const { id, invoice_payload: payload, total_amount: amount, from } = query;

  try {
    const { kind, productId, userId } = service.parseInvoicePayload(payload);

    if (kind !== 'build' || !productId || !userId) {
      await bot.answerPreCheckoutQuery(id, false, 'This invoice is malformed. Please try again.');
      return;
    }

    // Both sides composite. Comparing a raw Telegram id against a stored
    // "telegram:<id>" never matches, which would reject every paid invoice.
    if (service.normalizeUserId(from.id) !== userId) {
      await bot.answerPreCheckoutQuery(id, false, 'This invoice belongs to another account.');
      return;
    }

    const product = PRODUCTS_BY_ID[productId];
    if (!product || product.free) {
      await bot.answerPreCheckoutQuery(id, false, 'That product is no longer available.');
      return;
    }

    if (Number(amount) !== product.starCost) {
      logger.warn({ payload, amount, expected: product.starCost }, 'Pre-checkout amount mismatch');
      await bot.answerPreCheckoutQuery(id, false, 'The price has changed. Please reopen the shop.');
      return;
    }

    await bot.answerPreCheckoutQuery(id, true);
    logger.info({ payload, amount, userId }, 'Pre-checkout approved');
  } catch (err) {
    logger.error({ err: err.message }, 'Pre-checkout threw');
    await bot
      .answerPreCheckoutQuery(id, false, 'Something went wrong. Please try again.')
      .catch(() => {});
  }
}

/** Routes a non-pre-checkout update. */
async function processUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return;

  if (message.successful_payment) {
    await handleSuccessfulPayment(message);
    return;
  }

  if (typeof message.text !== 'string') return;

  if (message.text.startsWith('/')) {
    await handleCommand(message);
    return;
  }

  await handleIntakeText(message);
}

/**
 * Fulfils a completed Stars payment, then delivers.
 *
 * Generation takes about a minute, so a progress message is edited in place
 * while it runs. A frozen "building" message reads as broken; one that visibly
 * advances reads as working.
 */
async function handleSuccessfulPayment(message) {
  const sp = message.successful_payment;
  const userId = String(message.from.id);
  const chatId = message.chat.id;

  const { productId } = service.parseInvoicePayload(sp.invoice_payload);
  const product = PRODUCTS_BY_ID[productId];

  logger.info(
    { userId, chargeId: sp.telegram_payment_charge_id, stars: sp.total_amount, productId },
    'Successful payment received'
  );

  const progress = await bot
    .sendMessage(chatId, `⚡ Paid. Building your <b>${product?.name || 'build'}</b>…`)
    .catch(() => null);

  const tick = (text) =>
    progress ? bot.editMessageText(chatId, progress.message_id, text) : Promise.resolve();

  const result = await service.fulfilPayment({
    userId,
    productId,
    stars: Number(sp.total_amount),
    telegramChargeId: sp.telegram_payment_charge_id,
    providerPaymentChargeId: sp.provider_payment_charge_id || null,
    invoicePayload: sp.invoice_payload,
    rawUpdate: sp,
    onProgress: ({ stage, label }) => {
      const icon = { brief: '🧭', pages: '✍️', css: '🎨', assemble: '📦' }[stage] || '⚙️';
      tick(`${icon} ${label}…`).catch(() => {});
    },
  });

  if (result.duplicate) return;

  if (!result.ok) {
    await tick('⚠️ Build failed.');
    await bot.sendMessage(
      chatId,
      [
        `⚠️ Your <b>${product?.name || 'build'}</b> could not be generated.`,
        '',
        result.refunded
          ? `Your <b>${sp.total_amount} ⭐</b> have been refunded automatically. Nothing to chase.`
          : `Your <b>${sp.total_amount} ⭐</b> refund did not go through automatically. Send /refund and it will be handled.`,
        '',
        `Receipt: <code>${sp.telegram_payment_charge_id}</code>`,
        '',
        'Send /start to try again.',
      ].join('\n')
    );
    return;
  }

  await tick('✅ Done.');
  await deliver(chatId, result.site, { stars: sp.total_amount, chargeId: sp.telegram_payment_charge_id });
}

/* ────────────────────────────────────────────────────────────
   DELIVERY
   ──────────────────────────────────────────────────────────── */

/** Sends the zip and the preview link for a finished build. */
async function deliver(chatId, site, opts = {}) {
  const urls = service.publicUrls(site);
  const pages = site.fileNames().filter((f) => f.endsWith('.html'));

  const lines = [
    `🎯 <b>${site.businessName}</b> is ready.`,
    '',
    `${pages.length} page${pages.length === 1 ? '' : 's'}: ${pages.join(', ')}`,
  ];

  if (urls.previewUrl) lines.push('', `👀 Live preview: ${urls.previewUrl}`);

  const warnings = (site.generationNotes || []).filter(
    (n) => n.includes('token limit') || n.includes('unclosed') || n.includes('placeholder')
  );
  if (warnings.length) {
    lines.push('', '⚠️ Worth a look before you publish:', ...warnings.map((w) => `• ${w}`));
  }

  if (opts.chargeId) {
    lines.push('', `Receipt: <code>${opts.chargeId}</code>`);
    lines.push('Not what you wanted? /refund — instant, no questions.');
  }

  await bot.sendMessage(chatId, lines.join('\n'), {
    reply_markup: bot.miniAppKeyboard('Open my builds'),
  });

  try {
    const zip = await service.zipBuild(site);
    await bot.sendDocument(
      chatId,
      zip,
      `${service.safeFolderName(site.businessName)}.zip`,
      'Extract the folder, then open any .html file. Every page is styled on its own.'
    );
  } catch (err) {
    logger.error({ err: err.message, siteId: site._id.toString() }, 'Zip delivery failed');
    await bot.sendMessage(
      chatId,
      urls.downloadUrl
        ? `The .zip could not be attached here. Download it instead: ${urls.downloadUrl}`
        : 'The .zip could not be attached. Open the app and download it from your builds.'
    );
  }
}

/* ────────────────────────────────────────────────────────────
   BOT INTAKE
   ──────────────────────────────────────────────────────────── */

const QUESTIONS = [
  { key: 'business', text: '<b>1 of 4.</b> What is the business called, and what does it do?' },
  { key: 'offer', text: '<b>2 of 4.</b> What does it sell? Include the price if there is one.' },
  { key: 'audience', text: '<b>3 of 4.</b> Who buys it? Be specific.' },
  {
    key: 'style',
    text:
      '<b>4 of 4.</b> Any style preference? Bold, minimal, warm, technical, luxury… or just say "you pick".',
  },
];

function productKeyboard() {
  return {
    inline_keyboard: PRODUCTS.map((p) => [
      {
        text: p.free
          ? `${p.name} — free`
          : `${p.name} — ${p.starCost} ⭐ (${usdApprox(p.starCost)})`,
        callback_data: `buy:${p.productId}`,
      },
    ]),
  };
}

async function handleIntakeText(message) {
  const userId = String(message.from.id);
  const user = await service.loadOwner(userId, {
    username: message.from.username,
    firstName: message.from.first_name,
    lastName: message.from.last_name,
    languageCode: message.from.language_code,
    isPremium: Boolean(message.from.is_premium),
  });

  const intake = user.intake;
  if (!intake || typeof intake.step !== 'number') {
    await bot.sendMessage(
      message.chat.id,
      'Send /start to build a website or funnel.',
      { reply_markup: bot.miniAppKeyboard() }
    );
    return;
  }

  const q = QUESTIONS[intake.step];
  if (!q) {
    user.intake = null;
    await user.save();
    return;
  }

  intake[q.key] = message.text.slice(0, 600);
  intake.step += 1;

  const next = QUESTIONS[intake.step];

  // Mongoose does not track mutations inside a Mixed field.
  user.intake = { ...intake };
  user.markModified('intake');
  await user.save();

  if (next) {
    await bot.sendMessage(message.chat.id, next.text);
    return;
  }

  await bot.sendMessage(
    message.chat.id,
    [
      '✅ Got it. Here is what I can build:',
      '',
      ...PRODUCTS.map((p) =>
        `<b>${p.name}</b> — ${p.free ? 'free' : `${p.starCost} ⭐ (${usdApprox(p.starCost)})`}\n${p.tagline}`
      ),
      '',
      'Buying from Telegram Desktop or Web gives you more value than in-app.',
    ].join('\n'),
    { reply_markup: productKeyboard() }
  );
}

/* ────────────────────────────────────────────────────────────
   CALLBACKS
   ──────────────────────────────────────────────────────────── */

async function handleCallback(query) {
  const userId = String(query.from.id);
  const chatId = query.message?.chat?.id;
  const data = String(query.data || '');

  const ack = (text) =>
    bot
      .callTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        ...(text ? { text: text.slice(0, 200) } : {}),
      })
      .catch(() => {});

  if (!data.startsWith('buy:')) {
    await ack();
    return;
  }

  const productId = data.slice(4);
  const product = PRODUCTS_BY_ID[productId];

  if (!product) {
    await ack('That product no longer exists.');
    return;
  }

  const user = await service.loadOwner(userId);
  const intake = user.intake;

  if (!intake || !intake.business || !intake.offer) {
    await ack();
    await bot.sendMessage(chatId, 'I need your answers first. Send /start.');
    return;
  }

  await ack();

  const inputs = {
    business: intake.business,
    offer: intake.offer,
    audience: intake.audience || '',
    style: intake.style || '',
  };

  /* ---- free tier: build immediately, no invoice ---------------------- */
  if (product.free) {
    const left = service.freeBuildsLeft(user);
    if (left <= 0) {
      const hrs = Math.ceil(service.freeWindowResetsIn(user) / 3600);
      await bot.sendMessage(
        chatId,
        `You have used your free build for today. It resets in about ${hrs} hour${hrs === 1 ? '' : 's'}.\n\nThe full website is ${PRODUCTS_BY_ID.site.starCost} ⭐ and ready now.`,
        { reply_markup: productKeyboard() }
      );
      return;
    }

    const claimed = await service.claimBuildSlot(userId);
    if (!claimed) {
      await bot.sendMessage(chatId, 'A build is already running. Give it a minute.');
      return;
    }

    const progress = await bot.sendMessage(chatId, '⚡ Building your free homepage…').catch(() => null);
    const tick = (t) =>
      progress ? bot.editMessageText(chatId, progress.message_id, t) : Promise.resolve();

    const result = await service
      .runBuild({
        userId,
        productId: product.productId,
        inputs,
        source: 'free',
        onProgress: ({ stage, label }) => {
          const icon = { brief: '🧭', pages: '✍️', css: '🎨', assemble: '📦' }[stage] || '⚙️';
          tick(`${icon} ${label}…`).catch(() => {});
        },
      })
      .catch((err) => ({ ok: false, error: err.message }));

    await service.releaseBuildSlot(userId);

    if (!result.ok) {
      await tick('⚠️ That one failed.');
      await bot.sendMessage(
        chatId,
        'That build failed and nothing was charged. Send /start to try again.'
      );
      return;
    }

    await tick('✅ Done.');
    await deliver(chatId, result.site);

    const fresh = await service.loadOwner(userId);
    await bot.sendMessage(
      chatId,
      [
        'That is one page. The full site is five, linked together with working navigation.',
        '',
        `<b>${PRODUCTS_BY_ID.site.name}</b> — ${PRODUCTS_BY_ID.site.starCost} ⭐`,
        `<b>${PRODUCTS_BY_ID.funnel.name}</b> — ${PRODUCTS_BY_ID.funnel.starCost} ⭐`,
        '',
        `Free builds left today: ${service.freeBuildsLeft(fresh)}`,
      ].join('\n'),
      { reply_markup: productKeyboard() }
    );
    return;
  }

  /* ---- paid tier: invoice, then build on payment --------------------- */
  try {
    const invoice = await service.createInvoice(userId, product.productId, inputs);

    // The payload must be byte-identical to the one on the pending row:
    // fulfilment looks the transaction up by it, and the intake answers live
    // there. Reconstructing it here instead of reusing it is how a paid build
    // ends up with nothing to build from.
    try {
      await bot.callTelegram('sendInvoice', {
        chat_id: chatId,
        title: product.name,
        description: `${product.description} Delivered instantly as a .zip plus a live preview link.`,
        payload: invoice.payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: product.name, amount: product.starCost }],
      });
    } catch {
      // Fall back to the link form, which carries the same payload.
      await bot.sendMessage(
        chatId,
        `Tap to pay ${product.starCost} ⭐ for your <b>${product.name}</b>:\n\n${invoice.invoiceLink}`
      );
    }
  } catch (err) {
    logger.error({ err: err.message, userId, productId }, 'Invoice creation failed');
    await bot.sendMessage(chatId, 'The invoice could not be created. Try again in a moment.');
  }
}

/* ────────────────────────────────────────────────────────────
   COMMANDS
   ──────────────────────────────────────────────────────────── */

async function handleCommand(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const userId = String(from.id);
  const [raw, ...args] = message.text.trim().split(/\s+/);
  const command = raw.split('@')[0];

  switch (command) {
    case '/start': {
      const user = await service.loadOwner(userId, {
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        languageCode: from.language_code,
        isPremium: Boolean(from.is_premium),
      });

      // Referral: credit only on a genuinely new owner, and never self-credit.
      const code = args[0] || null;
      if (code && !user.referredBy && user.buildsTotal === 0 && code !== user.referralCode) {
        const referrer = await User.findOne({ referralCode: code });
        // Compare composite ids. A bare `userId` would never equal a stored
        // "telegram:<id>", so the self-referral guard would pass and a user
        // could credit themselves with their own code.
        if (referrer && referrer.userId !== service.normalizeUserId(userId)) {
          user.referredBy = referrer.userId;
          await user.save();
          referrer.referrals += 1;
          await referrer.save();
        }
      }

      user.intake = { step: 0 };
      user.markModified('intake');
      await user.save();

      await bot.sendMessage(
        chatId,
        [
          `<b>${config.brandName}</b>`,
          '',
          'I build real websites and sales funnels. Four questions, about a minute, finished files.',
          '',
          `Your first homepage is free. Full site ${PRODUCTS_BY_ID.site.starCost} ⭐, funnel ${PRODUCTS_BY_ID.funnel.starCost} ⭐.`,
          '',
          QUESTIONS[0].text,
        ].join('\n'),
        { reply_markup: bot.miniAppKeyboard('Or use the app') }
      );
      break;
    }

    case '/pricing':
      await bot.sendMessage(
        chatId,
        [
          '<b>What things cost</b>',
          '',
          ...PRODUCTS.map((p) =>
            [
              `<b>${p.name}</b> — ${p.free ? 'free, one per day' : `${p.starCost} ⭐ (${usdApprox(p.starCost)})`}`,
              p.tagline,
              ...p.includes.map((i) => `• ${i}`),
              '',
            ].join('\n')
          ),
          'Stars only. Buying from Telegram Desktop or Web gives you more value than in-app.',
        ].join('\n'),
        { reply_markup: bot.miniAppKeyboard() }
      );
      break;

    case '/builds': {
      const sites = await service.listSites(userId, 10);
      if (!sites.length) {
        await bot.sendMessage(chatId, 'No builds yet. Send /start.');
        break;
      }
      const lines = sites.map((s) => {
        const urls = service.publicUrls(s);
        const mark = s.status === 'ready' ? '✅' : s.status === 'failed' ? '⚠️' : '⏳';
        return `${mark} <b>${s.businessName}</b> · ${s.name} · ${s.pageCount}pp${
          urls.previewUrl && s.status === 'ready' ? `\n   ${urls.previewUrl}` : ''
        }`;
      });
      await bot.sendMessage(chatId, ['<b>Your builds</b>', '', ...lines].join('\n'), {
        reply_markup: bot.miniAppKeyboard('Open in app'),
      });
      break;
    }

    case '/invite': {
      const user = await service.loadOwner(userId);
      const me = await bot.getMe().catch(() => null);
      const link = me
        ? `https://t.me/${me.username}?start=${user.referralCode}`
        : `referral code: ${user.referralCode}`;
      await bot.sendMessage(
        chatId,
        `Your referral link:\n\n<code>${link}</code>\n\nReferrals so far: ${user.referrals}`
      );
      break;
    }

    case '/refund': {
      const result = await service.refundByRequest(userId);
      if (!result.ok && result.reason === 'none') {
        await bot.sendMessage(chatId, 'No refundable order found.');
        break;
      }
      if (!result.ok) {
        await bot.sendMessage(
          chatId,
          'The refund did not go through. I have flagged it and it will be handled.'
        );
        break;
      }
      await bot.sendMessage(
        chatId,
        `Refunded <b>${result.stars} ⭐</b>. No hard feelings. Keep the files.`
      );
      break;
    }

    /**
     * Erasure. Two steps, unlike /refund — a refund is reversible, this is
     * not. It destroys the generated pages and kills every preview link the
     * person has shared.
     */
    case '/forget': {
      if (args[0] !== 'confirm') {
        const sites = await service.listSites(userId, 50);
        if (!sites.length) {
          await bot.sendMessage(
            chatId,
            'There is nothing stored for you beyond your Telegram user id.'
          );
          break;
        }
        await bot.sendMessage(
          chatId,
          [
            `This deletes <b>${sites.length} build${sites.length === 1 ? '' : 's'}</b>, the business`,
            'details you typed in, and your saved name.',
            '',
            '<b>Every preview link you have shared will stop working.</b>',
            'Download anything you still want first — /builds has the links.',
            '',
            'Your daily free-build count is kept, so this cannot reset the limit.',
            'Payment records are kept but stripped of anything you wrote.',
            '',
            'This cannot be undone. To go ahead, send:',
            '<code>/forget confirm</code>',
          ].join('\n')
        );
        break;
      }

      const result = await service.deleteUserData(userId);
      await bot.sendMessage(
        chatId,
        [
          `Deleted. ${result.sitesDeleted} build${result.sitesDeleted === 1 ? '' : 's'} removed,`,
          'along with everything you typed. Preview links are dead.',
          '',
          'Send /start any time to begin again.',
        ].join('\n')
      );
      break;
    }

    case '/help':
      await bot.sendMessage(
        chatId,
        [
          '/start — build a website or funnel',
          '/builds — your past builds',
          '/pricing — what things cost',
          '/invite — your referral link',
          '/refund — instant refund, no questions',
          '/forget — delete your builds and details',
          '',
          'A build takes about a minute. You get a .zip plus a live preview link.',
          'Every page works on its own: open any .html and it is already styled.',
        ].join('\n'),
        { reply_markup: bot.miniAppKeyboard() }
      );
      break;

    default:
      break;
  }
}

module.exports = router;
module.exports.deliver = deliver;
module.exports.QUESTIONS = QUESTIONS;
