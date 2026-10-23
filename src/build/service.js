'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');

const config = require('../config');
const logger = require('../utils/logger');
const { Errors } = require('../utils/errors');

const User = require('../models/User');
const Site = require('../models/Site');
const Transaction = require('../models/Transaction');

const { PRODUCTS_BY_ID, publicCatalog } = require('../catalog/products');
const { generateBuild } = require('../claude/siteGenerator');
const { budgetExceeded } = require('../claude/client');
const bot = require('../telegram/bot');

const { normalizeUserId, platformOf } = require('../utils/identity');

const DAY_MS = 24 * 60 * 60 * 1000;
/** A build is abandoned, not running, after this long. Unsticks a crashed slot. */
const STALE_BUILD_MS = 10 * 60 * 1000;

/* ────────────────────────────────────────────────────────────
   OWNERS
   ──────────────────────────────────────────────────────────── */

function newReferralCode() {
  return crypto.randomBytes(5).toString('hex');
}

/**
 * Loads or creates the owner.
 *
 * `upsert` with `$setOnInsert` means two simultaneous first requests cannot
 * create two users for the same Telegram id, which the unique index would
 * reject anyway but noisily.
 */
async function loadOwner(userId, profile = {}) {
  const id = normalizeUserId(userId);

  const update = {
    $set: { lastSeenAt: new Date() },
    $setOnInsert: {
      userId: id,
      platform: platformOf(id),
      referralCode: newReferralCode(),
      freeWindowStartedAt: new Date(),
    },
  };

  for (const key of ['username', 'firstName', 'lastName', 'languageCode', 'isPremium']) {
    if (profile[key] !== undefined && profile[key] !== null) update.$set[key] = profile[key];
  }

  const user = await User.findOneAndUpdate({ userId: id }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });

  // Backfill for rows created before referral codes existed.
  if (!user.referralCode) {
    user.referralCode = newReferralCode();
    await user.save();
  }

  return user;
}

/**
 * Owners bypass the daily free-build limit. See config.ownerIds.
 *
 * Ids are normalized on both sides, so OWNER_IDS can hold a bare Telegram id
 * or a prefixed one and still match the composite form actually stored.
 */
const OWNER_SET = new Set(config.ownerIds.map((id) => normalizeUserId(id)));

function isOwner(userId) {
  if (!userId) return false;
  try {
    return OWNER_SET.has(normalizeUserId(userId));
  } catch {
    return false;
  }
}

/**
 * A finite stand-in for "no limit".
 *
 * Not Infinity: this value is serialized into /api/state, and JSON.stringify
 * turns Infinity into null, which fails the owner schema's integer check and
 * renders as an empty slot in the Mini App.
 */
const UNLIMITED = 9999;

/**
 * Free builds reset on a rolling 24h window, computed on read.
 *
 * No cron job: a scheduled reset is one more thing that can silently stop
 * running, and nothing here needs a precise midnight boundary.
 */
function freeBuildsLeft(user) {
  if (isOwner(user?.userId)) return UNLIMITED;
  const started = user.freeWindowStartedAt ? user.freeWindowStartedAt.getTime() : 0;
  if (Date.now() - started >= DAY_MS) return config.build.freeBuildsPerDay;
  return Math.max(0, config.build.freeBuildsPerDay - (user.freeBuildsUsedToday || 0));
}

function freeWindowResetsIn(user) {
  const started = user.freeWindowStartedAt ? user.freeWindowStartedAt.getTime() : 0;
  return Math.max(0, Math.ceil((started + DAY_MS - Date.now()) / 1000));
}

async function consumeFreeBuild(user) {
  // An owner's quota is never checked, so counting against it would only
  // inflate a number that is meant to read as "builds used out of the daily
  // allowance". Lifetime totals still increment in runBuild.
  if (isOwner(user?.userId)) return;

  const started = user.freeWindowStartedAt ? user.freeWindowStartedAt.getTime() : 0;
  if (Date.now() - started >= DAY_MS) {
    user.freeWindowStartedAt = new Date();
    user.freeBuildsUsedToday = 0;
  }
  user.freeBuildsUsedToday += 1;
  user.freeBuildsUsed += 1;
  await user.save();
}

/* ────────────────────────────────────────────────────────────
   CONCURRENCY GUARD
   ──────────────────────────────────────────────────────────── */

/**
 * Claims the single build slot for this user.
 *
 * The conditional update is the whole point: two requests racing to start a
 * build both read "no active build", but only one write matches the filter.
 * Without it a double-tap on the Mini App runs two generations.
 *
 * `activeBuildStartedAt` is the only progress marker, and the claim sets it.
 * An earlier version also allowed `activeBuildId: null` to satisfy the filter,
 * which meant a claim in flight still matched and both racers won.
 */
async function claimBuildSlot(userId) {
  const id = normalizeUserId(userId);
  const staleBefore = new Date(Date.now() - STALE_BUILD_MS);

  const res = await User.findOneAndUpdate(
    {
      userId: id,
      $or: [
        { activeBuildStartedAt: null },
        { activeBuildStartedAt: { $exists: false } },
        { activeBuildStartedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { activeBuildStartedAt: new Date() } },
    { new: true }
  );

  return Boolean(res);
}

/** Records which build is running, without touching the slot marker. */
async function markActiveBuild(userId, siteId) {
  await User.updateOne(
    { userId: normalizeUserId(userId) },
    { $set: { activeBuildId: siteId } }
  ).catch(() => {});
}

/** Releases the slot. Safe to call when no slot was held. */
async function releaseBuildSlot(userId) {
  await User.updateOne(
    { userId: normalizeUserId(userId) },
    { $set: { activeBuildId: null, activeBuildStartedAt: null } }
  ).catch(() => {});
}

/* ────────────────────────────────────────────────────────────
   URLS
   ──────────────────────────────────────────────────────────── */

/**
 * Preview and download are capability URLs: the unguessable slug in the path
 * IS the credential.
 *
 * The alternative, a signed token in the query string, breaks as soon as the
 * visitor clicks a nav link. Generated pages link to each other relatively
 * ("about.html") so the folder works with no server, and a relative hop drops
 * the query string along with the token. A slug in the path survives it.
 */
function publicUrls(site) {
  const base = (config.telegram.publicBaseUrl || '').replace(/\/+$/, '');
  if (!base || !site.slug) return { previewUrl: null, downloadUrl: null };

  const entry = site.entryFile();

  return {
    previewUrl: `${base}/p/${site.slug}/${entry}`,
    downloadUrl: `${base}/d/${site.slug}.zip`,
  };
}

function sitePublic(site) {
  return site.toPublic(publicUrls(site));
}

/* ────────────────────────────────────────────────────────────
   ZIP
   ──────────────────────────────────────────────────────────── */

function safeFolderName(name) {
  return (
    String(name || 'website')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'website'
  );
}

async function zipBuild(site) {
  const zip = new JSZip();
  const folder = zip.folder(safeFolderName(site.businessName || site.name));

  for (const [filename, content] of site.fileEntries()) {
    folder.file(filename, content);
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/* ────────────────────────────────────────────────────────────
   INVOICES
   ──────────────────────────────────────────────────────────── */

/**
 * Creates a pending transaction and a Stars invoice link.
 *
 * The payload is `build:<productId>:<userId>`. The pre-checkout handler splits
 * it, re-derives the price from the catalog and verifies the buyer matches,
 * which is what makes a tampered invoice unusable.
 */
async function createInvoice(userId, productId, inputs) {
  const id = normalizeUserId(userId);
  const product = PRODUCTS_BY_ID[productId];

  if (!product) throw Errors.unknownProduct(productId);
  if (product.free) throw Errors.badRequest('That product is free. No invoice needed.');

  const clean = validateInputs(inputs);

  // The payload is unique per invoice so a buyer who abandons one and starts
  // another does not have the first pending row claimed by the second payment.
  //
  // Pipe-delimited, not colon-delimited. User ids became composite
  // ("telegram:100002"), and a colon-joined payload splits into the WRONG
  // fields: the pre-checkout handler read field 3 as the buyer and got
  // "telegram", compared it to the real payer id, and rejected every single
  // paid invoice. parseInvoicePayload still accepts the old colon form so
  // invoices already open at deploy time can still be paid.
  const payload = `build|${product.productId}|${id}|${crypto.randomBytes(4).toString('hex')}`;

  const tx = await Transaction.create({
    userId: id,
    platform: platformOf(id),
    kind: 'stars_purchase',
    stars: product.starCost,
    productId: product.productId,
    invoicePayload: payload,
    inputs: clean,
    status: 'pending',
  });

  const invoiceLink = await bot.createStarsInvoiceLink({
    title: product.name,
    description: `${product.description} Delivered instantly as a .zip plus a live preview link.`,
    payload,
    starAmount: product.starCost,
  });

  return {
    mode: 'invoice',
    invoiceLink,
    payload,
    productId: product.productId,
    starCost: product.starCost,
    transactionId: tx._id.toString(),
  };
}

/**
 * Reads an invoice payload back.
 *
 * Two formats, because a deploy cannot retroactively change an invoice that is
 * already sitting unpaid in someone's chat:
 *
 *   current  build|<productId>|<platform>:<rawId>|<nonce>
 *   legacy   build:<productId>:<bareTelegramId>:<nonce>
 *
 * Returns `userId` already normalized to composite form, so callers can
 * compare it directly against a loaded owner.
 */
function parseInvoicePayload(payload) {
  const s = String(payload || '');
  const miss = { kind: null, productId: null, userId: null, nonce: null };

  if (s.includes('|')) {
    const [kind, productId, userId, nonce] = s.split('|');
    if (!kind || !productId || !userId) return miss;
    return { kind, productId, userId: normalizeUserId(userId), nonce: nonce || null };
  }

  const parts = s.split(':');
  if (parts.length < 3) return miss;
  const [kind, productId, rawUser, nonce] = parts;
  if (!kind || !productId || !rawUser) return miss;
  return { kind, productId, userId: normalizeUserId(rawUser), nonce: nonce || null };
}

/* ────────────────────────────────────────────────────────────
   THE BUILD
   ──────────────────────────────────────────────────────────── */

function validateInputs(inputs = {}) {
  const business = String(inputs.business || '').trim();
  const offer = String(inputs.offer || '').trim();
  const audience = String(inputs.audience || '').trim();

  if (!business) throw Errors.badRequest('Tell me the business name or what it does.');
  if (!offer) throw Errors.badRequest('Tell me what the business sells.');

  return {
    business: business.slice(0, 600),
    offer: offer.slice(0, 600),
    audience: audience.slice(0, 600),
    style: String(inputs.style || '').trim().slice(0, 200),
  };
}

/**
 * Runs one build end to end and persists it.
 *
 * Returns `{ ok, site }` or `{ ok: false, error }`. Like the generator, this
 * does not throw for a generation failure: the caller may be holding a
 * successful payment and needs to decide about a refund.
 */
async function runBuild({ userId, productId, inputs, source = 'stars', transaction = null, onProgress }) {
  const id = normalizeUserId(userId);
  const product = PRODUCTS_BY_ID[productId];
  if (!product) throw Errors.unknownProduct(productId);

  const clean = validateInputs(inputs);

  const site = await Site.create({
    userId: id,
    platform: platformOf(id),
    productId: product.productId,
    name: product.name,
    businessName: clean.business.slice(0, 80),
    inputs: clean,
    source,
    starsSpent: source === 'free' ? 0 : product.starCost,
    transactionId: transaction?._id || null,
    status: 'generating',
  });

  await markActiveBuild(id, site._id);

  const result = await generateBuild(product, clean, { onProgress });

  if (!result.ok) {
    site.status = 'failed';
    site.error = result.error || 'Generation failed';
    site.generationNotes = result.notes || [];
    site.generationMs = result.ms;
    await site.save();
    await markActiveBuild(id, null);

    logger.warn({ userId: id, productId, error: site.error }, 'Build failed');
    return { ok: false, site, error: site.error };
  }

  site.files = Site.toFileArray(result.files);
  site.pageCount = result.pageCount;
  site.bytes = result.bytes;
  site.businessName = result.brief?.businessName || site.businessName;
  site.generationModel = result.model;
  site.generationMs = result.ms;
  site.generationNotes = result.notes || [];
  site.status = 'ready';
  await site.save();

  const user = await loadOwner(id);
  user.buildsTotal += 1;
  if (product.kind === 'funnel') user.funnelsBuilt += 1;
  else user.sitesBuilt += 1;
  if (source !== 'free') user.starsSpent += product.starCost;
  user.activeBuildId = null;
  await user.save();

  if (source === 'free') await consumeFreeBuild(user);

  if (transaction) {
    transaction.status = 'fulfilled';
    transaction.siteId = site._id;
    await transaction.save();
  }

  logger.info(
    { userId: id, productId, siteId: site._id.toString(), ms: result.ms, bytes: result.bytes },
    'Build ready'
  );

  return { ok: true, site };
}

/* ────────────────────────────────────────────────────────────
   PAYMENT FULFILMENT
   ──────────────────────────────────────────────────────────── */

/**
 * Fulfils a completed Stars payment.
 *
 * Idempotency comes from the unique index on `telegramChargeId`: a replayed
 * webhook delivery hits it, is detected here, and returns `duplicate` instead
 * of building and billing a second time.
 *
 * If generation fails, the Stars are refunded automatically. A buyer who paid
 * for a website and received nothing must not have to ask: an unanswered
 * failure becomes a chargeback, and chargebacks put the payment rail itself
 * at risk.
 */
async function fulfilPayment({
  userId,
  productId,
  stars,
  telegramChargeId,
  providerPaymentChargeId,
  invoicePayload,
  rawUpdate,
  inputs,
  onProgress,
}) {
  const id = normalizeUserId(userId);

  let tx;
  try {
    tx = await Transaction.findOneAndUpdate(
      { invoicePayload, status: 'pending' },
      {
        $set: {
          status: 'paid',
          telegramChargeId,
          providerPaymentChargeId: providerPaymentChargeId || null,
          rawUpdate,
        },
      },
      { new: true }
    );

    // No pending row: either the invoice came from an older deploy, or this is
    // a replay. Creating the row is what surfaces the difference, because the
    // unique index rejects a charge id we have already fulfilled.
    if (!tx) {
      tx = await Transaction.create({
        userId: id,
        platform: platformOf(id),
        kind: 'stars_purchase',
        stars,
        productId,
        invoicePayload,
        telegramChargeId,
        providerPaymentChargeId: providerPaymentChargeId || null,
        status: 'paid',
        rawUpdate,
      });
    }
  } catch (err) {
    if (err.code === 11000) {
      logger.info({ telegramChargeId }, 'Duplicate payment update ignored');
      const existing = await Transaction.findOne({ telegramChargeId });
      return { duplicate: true, transactionId: existing?._id?.toString() || null };
    }
    throw err;
  }

  const useInputs = inputs || tx.inputs || null;

  if (!useInputs) {
    // Paid, but we have nothing to build from. Refund rather than hold money
    // against an order that cannot be fulfilled.
    const refunded = await safeRefund(id, telegramChargeId);
    tx.status = refunded ? 'refunded' : 'failed';
    tx.error = 'No build inputs were attached to this payment';
    await tx.save();
    return { duplicate: false, ok: false, refunded, error: tx.error, transaction: tx };
  }

  const result = await runBuild({
    userId: id,
    productId,
    inputs: useInputs,
    source: 'stars',
    transaction: tx,
    onProgress,
  }).catch((err) => ({ ok: false, error: err.message }));

  if (!result.ok) {
    const refunded = await safeRefund(id, telegramChargeId);
    tx.status = refunded ? 'refunded' : 'failed';
    tx.error = result.error || 'Generation failed';
    await tx.save();

    if (result.site) {
      result.site.status = refunded ? 'refunded' : 'failed';
      await result.site.save().catch(() => {});
    }

    await bot.ops(
      `🔴 BUILD FAILED · ${productId} · user ${id} · refunded=${refunded} · ${tx.error}`
    );

    return {
      duplicate: false,
      ok: false,
      refunded,
      starsReturned: refunded ? stars : 0,
      error: tx.error,
      site: result.site || null,
      transaction: tx,
    };
  }

  await bot.ops(`💰 SALE ${stars}⭐ · ${productId} · user ${id}`);

  return { duplicate: false, ok: true, site: result.site, transaction: tx };
}

/** Refunds without throwing. Returns whether Telegram accepted it. */
async function safeRefund(userId, telegramChargeId) {
  if (!telegramChargeId) return false;
  try {
    await bot.refundStarPayment(userId, telegramChargeId);
    logger.info({ userId, telegramChargeId }, 'Stars refunded');
    return true;
  } catch (err) {
    logger.error({ userId, telegramChargeId, err: err.message }, 'Refund failed');
    await bot.ops(`🔴 REFUND FAILED · user ${userId} · charge ${telegramChargeId} · ${err.message}`);
    return false;
  }
}

/** The most recent paid, unrefunded order. Powers /refund. */
async function latestRefundable(userId) {
  return Transaction.findOne({
    userId: normalizeUserId(userId),
    kind: 'stars_purchase',
    telegramChargeId: { $ne: null },
    status: { $in: ['paid', 'fulfilled', 'failed'] },
  })
    .sort({ createdAt: -1 })
    .limit(1);
}

async function refundByRequest(userId) {
  const tx = await latestRefundable(userId);
  if (!tx) return { ok: false, reason: 'none' };

  const refunded = await safeRefund(userId, tx.telegramChargeId);
  if (!refunded) return { ok: false, reason: 'rejected', transaction: tx };

  tx.status = 'refunded';
  await tx.save();

  if (tx.siteId) {
    await Site.updateOne({ _id: tx.siteId }, { $set: { status: 'refunded' } }).catch(() => {});
  }

  return { ok: true, stars: tx.stars, transaction: tx };
}

/* ────────────────────────────────────────────────────────────
   ERASURE
   ──────────────────────────────────────────────────────────── */

/**
 * Erases a person's content and identifying details.
 *
 * Three deliberate asymmetries, because "delete everything" is the wrong
 * answer to all three:
 *
 * 1. The User row SURVIVES, scrubbed. Deleting it would reset the daily
 *    free-build counter, turning erasure into an unlimited-builds exploit.
 *    Counters are not personal data; the name attached to them is, and that
 *    is what gets cleared.
 *
 * 2. Transactions survive, with their intake answers and raw payment payload
 *    nulled. The amount, status and charge id are financial records — they
 *    back a refund the buyer may still be entitled to, and Telegram allows
 *    refunds for 21 days after a charge.
 *
 * 3. Sites are deleted outright. They hold the generated pages and the
 *    business description that was typed in, which is the actual content.
 *    Deleting them also kills the public preview URLs, which is the point:
 *    those slugs are capability URLs and work for anyone holding the link.
 */
async function deleteUserData(userId) {
  const id = normalizeUserId(userId);

  const sites = await Site.deleteMany({ userId: id });

  const txs = await Transaction.updateMany(
    { userId: id },
    { $set: { inputs: null, rawUpdate: null } }
  );

  await User.updateOne(
    { userId: id },
    {
      $set: {
        username: null,
        firstName: null,
        lastName: null,
        languageCode: null,
        intake: null,
        activeBuildId: null,
        activeBuildStartedAt: null,
      },
    }
  );

  logger.info(
    { userId: id, sites: sites.deletedCount, transactions: txs.modifiedCount },
    'User data erased'
  );

  return {
    sitesDeleted: sites.deletedCount || 0,
    transactionsScrubbed: txs.modifiedCount || 0,
  };
}

/* ────────────────────────────────────────────────────────────
   READ MODEL
   ──────────────────────────────────────────────────────────── */

async function getState(userId, profile = {}) {
  const id = normalizeUserId(userId);
  const user = await loadOwner(id, profile);

  const sites = await Site.find({ userId: id }).sort({ createdAt: -1 }).limit(25);

  const active = user.activeBuildStartedAt
    ? { startedAt: user.activeBuildStartedAt, siteId: user.activeBuildId?.toString() || null }
    : null;

  return {
    owner: user.toPublic(freeBuildsLeft(user)),
    builds: sites.map(sitePublic),
    catalog: publicCatalog(),
    activeBuild: active,
    paused: budgetExceeded(),
  };
}

/**
 * A user's builds, newest first.
 *
 * Exists so no caller queries Site by a raw userId. Since ids became
 * composite ("<platform>:<rawId>"), a direct `Site.find({ userId })` with a
 * bare platform id silently matches nothing — it returns an empty list rather
 * than an error, so the bug reads as "this user has no builds".
 */
async function listSites(userId, limit = 10) {
  return Site.find({ userId: normalizeUserId(userId) })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 10, 50));
}

async function getSiteBySlug(slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{10,64}$/.test(slug)) return null;
  return Site.findOne({ slug });
}

async function getOwnedSite(userId, siteId) {
  if (!/^[a-f0-9]{24}$/i.test(String(siteId))) throw Errors.badRequest('Bad build id');
  const site = await Site.findById(siteId);
  if (!site) throw Errors.notFound('No such build');
  if (site.userId !== normalizeUserId(userId)) throw Errors.forbidden('That build is not yours');
  return site;
}

module.exports = {
  loadOwner,
  freeBuildsLeft,
  isOwner,
  UNLIMITED,
  freeWindowResetsIn,
  consumeFreeBuild,
  claimBuildSlot,
  markActiveBuild,
  releaseBuildSlot,
  createInvoice,
  parseInvoicePayload,
  runBuild,
  fulfilPayment,
  refundByRequest,
  latestRefundable,
  safeRefund,
  getState,
  deleteUserData,
  listSites,
  getSiteBySlug,
  getOwnedSite,
  zipBuild,
  publicUrls,
  sitePublic,
  validateInputs,
  safeFolderName,
  normalizeUserId,
};
