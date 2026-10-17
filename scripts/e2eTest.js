#!/usr/bin/env node
'use strict';

/**
 * End-to-end test against a real (in-memory) MongoDB, exercising the full HTTP
 * surface: auth, the free build, invoicing, the payment webhook, idempotency,
 * auto-refund, the capability URLs and the concurrency guard.
 *
 * Claude and the Telegram Bot API are stubbed in the require cache before the
 * app loads, so this runs offline and costs nothing. Everything between them
 * is the real code path.
 *
 * Requires: npm install --no-save mongodb-memory-server
 * Run with: npm run test:e2e
 */

process.env.NODE_ENV = 'development';
process.env.TELEGRAM_BOT_TOKEN = '123456:E2E-TEST-TOKEN';
process.env.TELEGRAM_WEBHOOK_SECRET = 'e2e-webhook-secret';
process.env.PUBLIC_BASE_URL = 'https://e2e.example.com';
process.env.MINI_APP_URL = 'https://e2e.example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-e2e';
process.env.ALLOW_DEV_AUTH = 'false';
process.env.FREE_BUILDS_PER_DAY = '1';
process.env.PRICE_SITE_STARS = '1500';
process.env.PRICE_FUNNEL_STARS = '3800';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { MongoMemoryServer } = require(path.join(ROOT, 'node_modules', 'mongodb-memory-server'));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/* ────────────────────────────────────────────────────────────
   STUBS — installed before the app is required
   ──────────────────────────────────────────────────────────── */

/** Records every Bot API call so assertions can inspect them. */
const sent = [];

/** Flipped by a test to make generation fail on demand. */
const generator = { shouldFail: false, calls: 0 };

function installStubs() {
  const botPath = require.resolve(path.join(ROOT, 'src/telegram/bot.js'));
  require.cache[botPath] = {
    id: botPath,
    filename: botPath,
    loaded: true,
    exports: {
      callTelegram: async (method, payload) => {
        sent.push({ method, payload });
        if (method === 'getMe') return { username: 'e2ebot', id: 1 };
        return { ok: true };
      },
      createStarsInvoiceLink: async ({ payload, starAmount }) => {
        sent.push({ method: 'createInvoiceLink', payload: { payload, starAmount } });
        return `https://t.me/invoice/${encodeURIComponent(payload)}`;
      },
      answerPreCheckoutQuery: async (id, ok, msg) => {
        sent.push({ method: 'answerPreCheckoutQuery', payload: { id, ok, msg } });
        return true;
      },
      sendMessage: async (chatId, text, extra) => {
        sent.push({ method: 'sendMessage', payload: { chatId, text, extra } });
        return { message_id: sent.length };
      },
      editMessageText: async (chatId, messageId, text) => {
        sent.push({ method: 'editMessageText', payload: { chatId, messageId, text } });
        return true;
      },
      sendDocument: async (chatId, buffer, filename) => {
        sent.push({ method: 'sendDocument', payload: { chatId, filename, bytes: buffer.length } });
        return true;
      },
      refundStarPayment: async (userId, chargeId) => {
        sent.push({ method: 'refundStarPayment', payload: { userId, chargeId } });
        return true;
      },
      setWebhook: async () => true,
      deleteWebhook: async () => true,
      getWebhookInfo: async () => ({ url: '' }),
      getMe: async () => ({ username: 'e2ebot', id: 1 }),
      setMyCommands: async () => true,
      miniAppKeyboard: () => undefined,
      ops: async (text) => {
        sent.push({ method: 'ops', payload: { text } });
      },
    },
  };

  const genPath = require.resolve(path.join(ROOT, 'src/claude/siteGenerator.js'));
  const real = require(genPath);
  require.cache[genPath].exports = {
    ...real,
    generateBuild: async (product, inputs, opts = {}) => {
      generator.calls += 1;
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ stage: 'brief', label: 'Planning' });
        opts.onProgress({ stage: 'pages', label: 'Writing' });
      }

      if (generator.shouldFail) {
        return { ok: false, notes: ['stub failure'], ms: 5, error: 'Stubbed generation failure' };
      }

      const files = {};
      let bytes = 0;
      for (const page of product.pages) {
        const doc = `<!DOCTYPE html><html><head><title>${inputs.business}</title><style>:root{--bg:#fff}</style></head><body><h1>${page.label}</h1></body></html>`;
        files[page.filename] = doc;
        bytes += Buffer.byteLength(doc, 'utf8');
      }
      files['style.css'] = ':root{--bg:#fff}';
      files['README.txt'] = 'stub';

      return {
        ok: true,
        files,
        brief: { businessName: inputs.business },
        pageCount: product.pages.length,
        bytes,
        notes: [],
        model: 'stub-model',
        ms: 10,
      };
    },
  };
}

/* ────────────────────────────────────────────────────────────
   HTTP helper
   ──────────────────────────────────────────────────────────── */

let baseUrl = '';

function signInitData(userId, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, username: `u${userId}`, first_name: 'Test' }),
    ...extra,
  });

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

async function call(method, routePath, { body, initData, headers = {}, raw = false } = {}) {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  if (raw) {
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body, e.g. a served preview page */
  }
  return { status: res.status, json, text };
}

const INPUTS = {
  business: 'Ridgeline Plumbing, emergency callouts in Denver',
  offer: '$149 drain clearing, same day',
  audience: 'Homeowners with an urgent blockage',
  style: 'Clean and trustworthy',
};

/* ────────────────────────────────────────────────────────────
   RUN
   ──────────────────────────────────────────────────────────── */

async function main() {
  console.log('\nWebMachine end-to-end test\n');

  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('webmachine-e2e');

  installStubs();

  const { connectDb, disconnectDb } = require(path.join(ROOT, 'src/db/connect'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const Transaction = require(path.join(ROOT, 'src/models/Transaction'));
  const Site = require(path.join(ROOT, 'src/models/Site'));
  const User = require(path.join(ROOT, 'src/models/User'));

  await connectDb();

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ALICE = 100001;
  const BOB = 100002;
  const alice = signInitData(ALICE);
  const bob = signInitData(BOB);

  /* ---- health & meta ------------------------------------------------- */

  await test('GET /health reports a connected database', async () => {
    const r = await call('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.db, 'connected');
  });

  await test('GET /pricing.json exposes the catalog publicly', async () => {
    const r = await call('GET', '/pricing.json');
    assert.strictEqual(r.status, 200);
    const ids = r.json.data.catalog.map((p) => p.productId).sort();
    assert.deepStrictEqual(ids, ['funnel', 'preview', 'site']);
  });

  await test('the catalog prices match the configured env', async () => {
    const r = await call('GET', '/pricing.json');
    const by = Object.fromEntries(r.json.data.catalog.map((p) => [p.productId, p.starCost]));
    assert.strictEqual(by.preview, 0);
    assert.strictEqual(by.site, 1500);
    assert.strictEqual(by.funnel, 3800);
  });

  /* ---- auth ---------------------------------------------------------- */

  await test('an unauthenticated API call is rejected', async () => {
    const r = await call('GET', '/api/state');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error.code, 'UNAUTHORIZED');
  });

  await test('a forged init-data hash is rejected', async () => {
    const forged = new URLSearchParams(alice);
    forged.set('user', JSON.stringify({ id: 999, username: 'attacker' }));
    const r = await call('GET', '/api/state', { initData: forged.toString() });
    assert.strictEqual(r.status, 401);
  });

  await test('an error response carries the UI envelope', async () => {
    const r = await call('GET', '/api/state');
    assert.ok(r.json.ui, 'no ui envelope');
    assert.strictEqual(r.json.ui.error.inline, false, 'UNAUTHORIZED should take over');
  });

  /* ---- state --------------------------------------------------------- */

  await test('first authenticated call creates the owner', async () => {
    const r = await call('GET', '/api/state', { initData: alice });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.owner.userId, String(ALICE));
    assert.strictEqual(r.json.data.owner.freeBuildsLeft, 1);
    assert.strictEqual(r.json.data.builds.length, 0);
    assert.ok(r.json.data.owner.referralCode, 'no referral code issued');
  });

  await test('calling state twice does not create a second owner', async () => {
    await call('GET', '/api/state', { initData: alice });
    assert.strictEqual(await User.countDocuments({ userId: String(ALICE) }), 1);
  });

  /* ---- the free build ------------------------------------------------ */

  let aliceSlug = null;

  await test('POST /api/build runs the free tier and returns a ready build', async () => {
    const r = await call('POST', '/api/build', {
      initData: alice,
      body: { productId: 'preview', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.build.status, 'ready');
    assert.strictEqual(r.json.data.build.pageCount, 1);
    assert.ok(r.json.data.build.previewUrl, 'no preview url');
    assert.ok(r.json.data.build.downloadUrl, 'no download url');
    assert.strictEqual(r.json.data.owner.freeBuildsLeft, 0);

    const site = await Site.findById(r.json.data.build.id);
    aliceSlug = site.slug;
    assert.ok(aliceSlug && aliceSlug.length >= 16, 'slug too short to be a credential');
  });

  await test('the free build charged nothing and counted once', async () => {
    const user = await User.findOne({ userId: String(ALICE) });
    assert.strictEqual(user.starsSpent, 0);
    assert.strictEqual(user.buildsTotal, 1);
    assert.strictEqual(user.sitesBuilt, 1);
    assert.strictEqual(await Transaction.countDocuments({ userId: String(ALICE) }), 0);
  });

  await test('the second free build in the window is refused', async () => {
    const r = await call('POST', '/api/build', {
      initData: alice,
      body: { productId: 'preview', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, 'FREE_BUILD_USED');
    assert.strictEqual(r.json.ui.error.inline, true, 'this one should be a toast');
  });

  await test('a paid product cannot be built through the free endpoint', async () => {
    const r = await call('POST', '/api/build', {
      initData: bob,
      body: { productId: 'site', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /paid/i);
  });

  await test('a build with no business name is refused before any model call', async () => {
    const before = generator.calls;
    const r = await call('POST', '/api/build', {
      initData: bob,
      body: { productId: 'preview', inputs: { offer: 'things' } },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(generator.calls, before, 'validation ran after the generator');
  });

  /* ---- capability URLs ----------------------------------------------- */

  await test('the preview serves the generated page with no auth', async () => {
    const r = await call('GET', `/p/${aliceSlug}/index.html`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.startsWith('<!DOCTYPE html>'), 'not an html document');
    assert.ok(r.text.includes('Ridgeline'), 'business name missing from the page');
  });

  await test('the bare preview path redirects to the entry page', async () => {
    const r = await call('GET', `/p/${aliceSlug}`);
    assert.strictEqual(r.status, 302);
  });

  await test('the download serves a real zip', async () => {
    const r = await call('GET', `/d/${aliceSlug}.zip`, { raw: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/zip');
    // Every zip starts with the local file header signature "PK\x03\x04".
    assert.strictEqual(r.buffer.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(r.buffer.length > 200, 'zip is suspiciously small');
  });

  await test('an unknown slug is a 404, not a 500', async () => {
    const r = await call('GET', '/p/aaaaaaaaaaaaaaaaaaaaaa/index.html');
    assert.strictEqual(r.status, 404);
  });

  await test('path traversal out of a build is refused', async () => {
    const r = await call('GET', `/p/${aliceSlug}/..%2F..%2Fpackage.json`);
    assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
    assert.ok(!r.text.includes('webmachine-backend'), 'served a file outside the build');
  });

  await test('a page that is not in the build is a 404', async () => {
    const r = await call('GET', `/p/${aliceSlug}/pricing.html`);
    assert.strictEqual(r.status, 404);
  });

  /* ---- ownership ----------------------------------------------------- */

  await test("another owner cannot read someone else's build", async () => {
    const site = await Site.findOne({ userId: String(ALICE) });
    const r = await call('GET', `/api/build/${site._id}`, { initData: bob });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error.code, 'FORBIDDEN');
  });

  await test('a malformed build id is a 400, not a cast crash', async () => {
    const r = await call('GET', '/api/build/not-an-id', { initData: alice });
    assert.strictEqual(r.status, 400);
  });

  /* ---- invoicing ----------------------------------------------------- */

  let invoicePayload = null;

  await test('POST /api/invoice creates a pending transaction carrying the intake', async () => {
    const r = await call('POST', '/api/invoice', {
      initData: bob,
      body: { productId: 'site', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.starCost, 1500);
    assert.ok(r.json.data.invoiceLink, 'no invoice link');

    invoicePayload = r.json.data.payload;
    const tx = await Transaction.findOne({ invoicePayload });
    assert.strictEqual(tx.status, 'pending');
    assert.strictEqual(tx.stars, 1500);
    assert.strictEqual(tx.inputs.business, INPUTS.business);
  });

  await test('the invoice payload binds the product and the buyer', async () => {
    const [kind, productId, userId] = invoicePayload.split(':');
    assert.strictEqual(kind, 'build');
    assert.strictEqual(productId, 'site');
    assert.strictEqual(userId, String(BOB));
  });

  await test('two invoices get different payloads', async () => {
    const r = await call('POST', '/api/invoice', {
      initData: bob,
      body: { productId: 'site', inputs: INPUTS },
    });
    assert.notStrictEqual(r.json.data.payload, invoicePayload);
  });

  await test('the free product cannot be invoiced', async () => {
    const r = await call('POST', '/api/invoice', {
      initData: bob,
      body: { productId: 'preview', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('an unknown product is refused', async () => {
    const r = await call('POST', '/api/invoice', {
      initData: bob,
      body: { productId: 'enterprise', inputs: INPUTS },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, 'UNKNOWN_PRODUCT');
  });

  /* ---- the webhook --------------------------------------------------- */

  const WH = { 'X-Telegram-Bot-Api-Secret-Token': process.env.TELEGRAM_WEBHOOK_SECRET };

  await test('the webhook rejects a missing secret token', async () => {
    const r = await call('POST', '/webhook/telegram', { body: { update_id: 1 } });
    assert.strictEqual(r.status, 401);
  });

  await test('the webhook rejects a wrong secret token', async () => {
    const r = await call('POST', '/webhook/telegram', {
      body: { update_id: 1 },
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
    });
    assert.strictEqual(r.status, 401);
  });

  function lastCall(method) {
    for (let i = sent.length - 1; i >= 0; i -= 1) if (sent[i].method === method) return sent[i];
    return null;
  }

  await test('pre-checkout approves a correctly priced invoice', async () => {
    const r = await call('POST', '/webhook/telegram', {
      headers: WH,
      body: {
        update_id: 10,
        pre_checkout_query: {
          id: 'pcq1',
          from: { id: BOB },
          invoice_payload: invoicePayload,
          total_amount: 1500,
        },
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(lastCall('answerPreCheckoutQuery').payload.ok, true);
  });

  await test('pre-checkout rejects an underpriced invoice', async () => {
    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: {
        update_id: 11,
        pre_checkout_query: {
          id: 'pcq2',
          from: { id: BOB },
          invoice_payload: invoicePayload,
          total_amount: 1,
        },
      },
    });
    const c = lastCall('answerPreCheckoutQuery');
    assert.strictEqual(c.payload.ok, false);
    assert.match(c.payload.msg, /price/i);
  });

  await test("pre-checkout rejects another account paying someone else's invoice", async () => {
    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: {
        update_id: 12,
        pre_checkout_query: {
          id: 'pcq3',
          from: { id: ALICE },
          invoice_payload: invoicePayload,
          total_amount: 1500,
        },
      },
    });
    const c = lastCall('answerPreCheckoutQuery');
    assert.strictEqual(c.payload.ok, false);
    assert.match(c.payload.msg, /another account/i);
  });

  await test('pre-checkout rejects a malformed payload', async () => {
    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: {
        update_id: 13,
        pre_checkout_query: {
          id: 'pcq4',
          from: { id: BOB },
          invoice_payload: 'garbage',
          total_amount: 1500,
        },
      },
    });
    assert.strictEqual(lastCall('answerPreCheckoutQuery').payload.ok, false);
  });

  /* ---- payment fulfilment -------------------------------------------- */

  const CHARGE = 'charge_abc_123';

  function paymentUpdate(updateId, payload, chargeId, stars = 1500, from = BOB) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: from },
        from: { id: from, username: `u${from}` },
        successful_payment: {
          currency: 'XTR',
          total_amount: stars,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: null,
        },
      },
    };
  }

  /** The webhook acks first and finishes in setImmediate, so give it a beat. */
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

  await test('a successful payment builds, fulfils and delivers', async () => {
    const before = generator.calls;
    const r = await call('POST', '/webhook/telegram', {
      headers: WH,
      body: paymentUpdate(20, invoicePayload, CHARGE),
    });
    assert.strictEqual(r.status, 200, 'webhook must ack 200 immediately');

    await settle();

    assert.strictEqual(generator.calls, before + 1, 'generator was not called');

    const tx = await Transaction.findOne({ telegramChargeId: CHARGE });
    assert.strictEqual(tx.status, 'fulfilled');
    assert.ok(tx.siteId, 'transaction has no site attached');

    const site = await Site.findById(tx.siteId);
    assert.strictEqual(site.status, 'ready');
    assert.strictEqual(site.productId, 'site');
    assert.strictEqual(site.starsSpent, 1500);
    assert.strictEqual(site.pageCount, 5);
    assert.strictEqual(site.businessName, INPUTS.business);

    assert.ok(lastCall('sendDocument'), 'the zip was never sent');
  });

  await test('the buyer counters moved exactly once', async () => {
    const user = await User.findOne({ userId: String(BOB) });
    assert.strictEqual(user.buildsTotal, 1);
    assert.strictEqual(user.starsSpent, 1500);
  });

  await test('replaying the same payment builds nothing a second time', async () => {
    const before = generator.calls;
    const docsBefore = await Site.countDocuments({ userId: String(BOB) });

    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: paymentUpdate(21, invoicePayload, CHARGE),
    });
    await settle();

    assert.strictEqual(generator.calls, before, 'the generator ran again on a replay');
    assert.strictEqual(await Site.countDocuments({ userId: String(BOB) }), docsBefore);
    assert.strictEqual(await Transaction.countDocuments({ telegramChargeId: CHARGE }), 1);
  });

  await test('a payment with no stored intake is refunded, not held', async () => {
    const orphan = `build:site:${BOB}:deadbeef`;
    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: paymentUpdate(22, orphan, 'charge_orphan'),
    });
    await settle();

    const refund = lastCall('refundStarPayment');
    assert.ok(refund, 'no refund was attempted');
    assert.strictEqual(refund.payload.chargeId, 'charge_orphan');

    const tx = await Transaction.findOne({ telegramChargeId: 'charge_orphan' });
    assert.strictEqual(tx.status, 'refunded');
  });

  await test('a failed generation auto-refunds the buyer', async () => {
    const inv = await call('POST', '/api/invoice', {
      initData: bob,
      body: { productId: 'funnel', inputs: INPUTS },
    });
    const payload = inv.json.data.payload;

    generator.shouldFail = true;
    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: paymentUpdate(23, payload, 'charge_fail', 3800),
    });
    await settle();
    generator.shouldFail = false;

    const refund = lastCall('refundStarPayment');
    assert.strictEqual(refund.payload.chargeId, 'charge_fail');

    const tx = await Transaction.findOne({ telegramChargeId: 'charge_fail' });
    assert.strictEqual(tx.status, 'refunded');

    const site = await Site.findById(tx.siteId || undefined).catch(() => null);
    if (site) assert.ok(['failed', 'refunded'].includes(site.status), site.status);

    const msg = sent.filter((s) => s.method === 'sendMessage').pop();
    assert.match(msg.payload.text, /refunded/i, 'the buyer was not told about the refund');
  });

  await test('a failed build did not increment the buyer counters', async () => {
    const user = await User.findOne({ userId: String(BOB) });
    assert.strictEqual(user.buildsTotal, 1, 'a failed build was counted');
    assert.strictEqual(user.starsSpent, 1500, 'a refunded build was still charged');
  });

  /* ---- refund on request --------------------------------------------- */

  await test('POST /api/refund refunds the most recent order', async () => {
    // A buyer of their own, because the tests above have already refunded
    // everything Bob ever paid for.
    const DAVE = 100004;
    const dave = signInitData(DAVE);
    await call('GET', '/api/state', { initData: dave });

    const inv = await call('POST', '/api/invoice', {
      initData: dave,
      body: { productId: 'site', inputs: INPUTS },
    });

    await call('POST', '/webhook/telegram', {
      headers: WH,
      body: paymentUpdate(30, inv.json.data.payload, 'charge_dave', 1500, DAVE),
    });
    await settle();

    const paid = await Transaction.findOne({ telegramChargeId: 'charge_dave' });
    assert.strictEqual(paid.status, 'fulfilled', 'the setup payment did not fulfil');

    const r = await call('POST', '/api/refund', { initData: dave, body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.ok, true);
    assert.strictEqual(r.json.data.starsReturned, 1500);

    const after = await Transaction.findOne({ telegramChargeId: 'charge_dave' });
    assert.strictEqual(after.status, 'refunded');

    const site = await Site.findById(after.siteId);
    assert.strictEqual(site.status, 'refunded', 'the build was left live after a refund');
  });

  await test('refund with nothing to refund is a clean 404', async () => {
    const r = await call('POST', '/api/refund', { initData: signInitData(100777), body: {} });
    assert.strictEqual(r.status, 404);
  });

  /* ---- concurrency --------------------------------------------------- */

  await test('two simultaneous free builds: exactly one wins', async () => {
    const carol = signInitData(100003);
    await call('GET', '/api/state', { initData: carol });

    const [a, b] = await Promise.all([
      call('POST', '/api/build', { initData: carol, body: { productId: 'preview', inputs: INPUTS } }),
      call('POST', '/api/build', { initData: carol, body: { productId: 'preview', inputs: INPUTS } }),
    ]);

    const wins = [a, b].filter((r) => r.status === 200).length;
    assert.strictEqual(wins, 1, `${wins} builds succeeded, expected 1`);

    const loser = [a, b].find((r) => r.status !== 200);
    assert.ok(
      ['BUILD_IN_PROGRESS', 'FREE_BUILD_USED'].includes(loser.json.error.code),
      loser.json.error.code
    );
    assert.strictEqual(await Site.countDocuments({ userId: '100003' }), 1);
  });

  /* ---- teardown ------------------------------------------------------ */

  await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.error('End-to-end test failed.');
    process.exit(1);
  }
  console.log('End-to-end test passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
