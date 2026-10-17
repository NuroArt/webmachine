'use strict';

const express = require('express');

const { telegramAuth } = require('../telegram/auth');
const { readLimiter, actionLimiter, buildLimiter } = require('../middleware/rateLimit');
const { ok } = require('../utils/schemas');
const { Errors } = require('../utils/errors');
const { PRODUCTS_BY_ID, publicCatalog } = require('../catalog/products');
const { budgetExceeded } = require('../claude/client');
const service = require('../build/service');
const logger = require('../utils/logger');

const router = express.Router();

/** Everything under /api is authenticated by Telegram initData. */
const auth = telegramAuth;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ────────────────────────────────────────────────────────────
   READS
   ──────────────────────────────────────────────────────────── */

router.get(
  '/catalog',
  readLimiter,
  asyncRoute(async (req, res) => {
    res.json(ok('catalog', { catalog: publicCatalog(), paused: budgetExceeded() }));
  })
);

const stateHandler = asyncRoute(async (req, res) => {
  const state = await service.getState(req.telegramUser.id, {
    username: req.telegramUser.username,
    firstName: req.telegramUser.firstName,
    lastName: req.telegramUser.lastName,
    languageCode: req.telegramUser.languageCode,
    isPremium: req.telegramUser.isPremium,
  });
  res.json(ok('state', state));
});

router.get('/state', auth, readLimiter, stateHandler);
router.post('/state', auth, readLimiter, stateHandler);

router.get(
  '/build/:id',
  auth,
  readLimiter,
  asyncRoute(async (req, res) => {
    const site = await service.getOwnedSite(req.telegramUser.id, req.params.id);
    res.json(ok('build', { build: service.sitePublic(site) }));
  })
);

/**
 * The generation notes. Exposed separately because they are diagnostic: byte
 * sizes, truncation warnings, leftover placeholder counts. Useful before
 * publishing, noise in the build list.
 */
router.get(
  '/build/:id/notes',
  auth,
  readLimiter,
  asyncRoute(async (req, res) => {
    const site = await service.getOwnedSite(req.telegramUser.id, req.params.id);
    res.json(
      ok('build_notes', {
        id: site._id.toString(),
        notes: site.generationNotes || [],
        model: site.generationModel,
        generationMs: site.generationMs,
      })
    );
  })
);

/* ────────────────────────────────────────────────────────────
   WRITES
   ──────────────────────────────────────────────────────────── */

/**
 * Creates a Stars invoice for a paid product.
 *
 * The Mini App opens the returned link with `Telegram.WebApp.openInvoice`.
 * The build itself does not happen here: it happens in the payment webhook,
 * which is the only place that knows the money actually arrived.
 */
router.post(
  '/invoice',
  auth,
  actionLimiter,
  asyncRoute(async (req, res) => {
    const productId = String(req.body?.productId || '');
    const product = PRODUCTS_BY_ID[productId];

    if (!product) throw Errors.unknownProduct(productId);
    if (product.free) throw Errors.badRequest('That product is free. Use /api/build instead.');
    if (budgetExceeded()) throw Errors.budgetExceeded();

    const invoice = await service.createInvoice(req.telegramUser.id, productId, req.body?.inputs);
    res.json(ok('invoice', invoice));
  })
);

/**
 * Runs a free build synchronously.
 *
 * Only the free tier is allowed through here. A paid build must be driven by
 * the payment webhook, or this endpoint would hand out paid product to anyone
 * who can call it.
 */
router.post(
  '/build',
  auth,
  buildLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.telegramUser.id;
    const productId = String(req.body?.productId || 'preview');
    const product = PRODUCTS_BY_ID[productId];

    if (!product) throw Errors.unknownProduct(productId);
    if (!product.free) throw Errors.badRequest('That product must be paid for. Request an invoice.');
    if (budgetExceeded()) throw Errors.budgetExceeded();

    const user = await service.loadOwner(userId, {
      username: req.telegramUser.username,
      firstName: req.telegramUser.firstName,
    });

    if (service.freeBuildsLeft(user) <= 0) {
      throw Errors.freeBuildUsed(service.freeWindowResetsIn(user));
    }

    const claimed = await service.claimBuildSlot(userId);
    if (!claimed) throw Errors.buildInProgress();

    let result;
    try {
      result = await service.runBuild({
        userId,
        productId,
        inputs: req.body?.inputs,
        source: 'free',
      });
    } finally {
      await service.releaseBuildSlot(userId);
    }

    if (!result.ok) throw Errors.generationFailed(result.error);

    const fresh = await service.loadOwner(userId);
    res.json(
      ok('build', {
        ok: true,
        build: service.sitePublic(result.site),
        owner: fresh.toPublic(service.freeBuildsLeft(fresh)),
      })
    );
  })
);

/** Self-service refund. Always granted, never asks why. */
router.post(
  '/refund',
  auth,
  actionLimiter,
  asyncRoute(async (req, res) => {
    const result = await service.refundByRequest(req.telegramUser.id);
    if (!result.ok && result.reason === 'none') throw Errors.notFound('No refundable order found');
    if (!result.ok) throw Errors.upstream('The refund was not accepted. It has been flagged.');
    res.json(ok('refund', { ok: true, starsReturned: result.stars }));
  })
);

/* ────────────────────────────────────────────────────────────
   PUBLIC CAPABILITY ROUTES
   ──────────────────────────────────────────────────────────── */

/**
 * Preview and download are mounted outside /api and are NOT initData
 * authenticated. The unguessable slug in the path is the credential.
 *
 * That is forced by two things. `Telegram.WebApp.openLink` hands the URL to
 * the system browser, which cannot carry the init-data header. And the
 * generated pages link to each other relatively, so a token in the query
 * string would be dropped the moment the visitor clicks through to the next
 * page. A slug in the path survives both.
 */
const publicRouter = express.Router();

const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,64}$/;

publicRouter.get(
  '/p/:slug/:filename',
  asyncRoute(async (req, res, next) => {
    const { slug, filename } = req.params;

    if (!SAFE_FILENAME.test(filename) || filename.includes('..')) {
      return next(Errors.badRequest('Bad filename'));
    }

    const site = await service.getSiteBySlug(slug);
    if (!site || site.status !== 'ready') return next(Errors.notFound('No such preview'));

    const content = site.getFile(filename);
    if (content === undefined) return next(Errors.notFound('No such page in this build'));

    const type = filename.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : filename.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'text/plain; charset=utf-8';

    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=60');
    // These pages are the buyer's own content, served from our origin. They
    // must not be framed by anyone else and must not inherit the app's CSP.
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.removeHeader('Content-Security-Policy');
    return res.send(content);
  })
);

/** Bare folder URL: serve the entry page so the link looks clean. */
publicRouter.get(
  '/p/:slug',
  asyncRoute(async (req, res, next) => {
    const site = await service.getSiteBySlug(req.params.slug);
    if (!site || site.status !== 'ready') return next(Errors.notFound('No such preview'));
    return res.redirect(302, `/p/${site.slug}/${site.entryFile()}`);
  })
);

publicRouter.get(
  '/d/:slug.zip',
  asyncRoute(async (req, res, next) => {
    const site = await service.getSiteBySlug(req.params.slug);
    if (!site || site.status !== 'ready') return next(Errors.notFound('No such download'));

    const zip = await service.zipBuild(site);
    const name = `${service.safeFolderName(site.businessName || site.name)}.zip`;

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('Content-Length', String(zip.length));
    logger.info({ slug: site.slug, bytes: zip.length }, 'Zip served');
    return res.send(zip);
  })
);

module.exports = router;
module.exports.publicRouter = publicRouter;
