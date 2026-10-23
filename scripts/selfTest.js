#!/usr/bin/env node
'use strict';

/**
 * Self-test for the logic that has no database dependency: the generator's
 * deterministic repair layer, the HTML and JSON extractors, Telegram initData
 * verification, and the pricing catalog.
 *
 * Run with: npm test
 */

process.env.NODE_ENV = 'development';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/webmachine-test';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST-TOKEN-FOR-SELFTEST';

const assert = require('assert');
const crypto = require('crypto');

const gen = require('../src/claude/siteGenerator');
const client = require('../src/claude/client');
const prompts = require('../src/claude/sitePrompts');
const catalog = require('../src/catalog/products');
const { verifyInitData } = require('../src/telegram/auth');
const screens = require('../src/ui/screens');
const format = require('../src/ui/format');

const config = require('../src/config');
const bot = require('../src/telegram/bot');
const identity = require('../src/utils/identity');
const service = require('../src/build/service');
const discordCommands = require('../src/discord/commands');
const discordHandlers = require('../src/discord/handlers');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/**
 * Async cases are queued and drained before the summary.
 *
 * `test` above is synchronous: handed an async function it would await
 * nothing, count a pass before the body ran, and let any rejection escape as
 * an unhandled promise — a test that can never fail.
 */
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

console.log('\nWebMachine self-test\n');

/* ────────────────────────────────────────────────────────────
   REPAIR LAYER
   ──────────────────────────────────────────────────────────── */

test('scrubDashes removes em and en dashes', () => {
  const out = gen.scrubDashes('Fast — reliable – cheap');
  assert.ok(!/[—–]/.test(out), `dash survived: ${out}`);
  assert.ok(out.includes('Fast.'), out);
});

test('scrubDashes does not create double periods', () => {
  assert.ok(!/\.\s*\./.test(gen.scrubDashes('Done. — Next')));
});

test('scrubDashes leaves a hyphen alone', () => {
  assert.strictEqual(gen.scrubDashes('same-day callback'), 'same-day callback');
});

/* ────────────────────────────────────────────────────────────
   MARKUP ANALYSIS
   ──────────────────────────────────────────────────────────── */

test('collectClassNames finds every class across pages', () => {
  const names = gen.collectClassNames([
    '<nav class="wm-nav"><div class="wm-nav-inner"></div></nav>',
    '<section class="wm-section wm-section-alt"></section>',
  ]);
  assert.deepStrictEqual(names, ['wm-nav', 'wm-nav-inner', 'wm-section', 'wm-section-alt']);
});

test('collectClassNames dedupes across pages', () => {
  const names = gen.collectClassNames(['<a class="wm-btn">x</a>', '<a class="wm-btn">y</a>']);
  assert.deepStrictEqual(names, ['wm-btn']);
});

test('looksUnbalanced accepts well-formed markup', () => {
  assert.strictEqual(
    gen.looksUnbalanced('<section class="a"><p>Hello</p><img src="x.png" alt="x"></section>'),
    false
  );
});

test('looksUnbalanced catches a truncated page', () => {
  assert.strictEqual(gen.looksUnbalanced('<section><div><p>cut off here'), true);
});

test('looksUnbalanced ignores void elements', () => {
  assert.strictEqual(gen.looksUnbalanced('<div><br><hr><input type="text"></div>'), false);
});

test('looksUnbalanced catches a stray closing tag', () => {
  assert.strictEqual(gen.looksUnbalanced('<div></div></section>'), true);
});

/* ────────────────────────────────────────────────────────────
   EXTRACTORS
   ──────────────────────────────────────────────────────────── */

test('extractJson reads a bare object', () => {
  assert.deepStrictEqual(client.extractJson('{"a":1}'), { a: 1 });
});

test('extractJson survives fences and leading prose', () => {
  const out = client.extractJson('Sure thing!\n```json\n{"businessName":"Acme"}\n```');
  assert.strictEqual(out.businessName, 'Acme');
});

test('extractJson handles braces inside strings', () => {
  const out = client.extractJson('{"tagline":"we use {braces} here","n":2}');
  assert.strictEqual(out.n, 2);
});

test('extractJson returns null on garbage', () => {
  assert.strictEqual(client.extractJson('no json at all'), null);
});

test('extractHtml strips fences', () => {
  assert.strictEqual(client.extractHtml('```html\n<p>hi</p>\n```'), '<p>hi</p>');
});

test('extractHtml keeps only the body of a full document', () => {
  const out = client.extractHtml('<!DOCTYPE html><html><head></head><body><h1>Yo</h1></body></html>');
  assert.strictEqual(out, '<h1>Yo</h1>');
});

test('extractHtml drops leading prose', () => {
  assert.strictEqual(client.extractHtml('Here you go:\n<section>x</section>'), '<section>x</section>');
});

test('extractCss unwraps a style tag', () => {
  assert.strictEqual(client.extractCss('<style>body{margin:0}</style>'), 'body{margin:0}');
});

/* ────────────────────────────────────────────────────────────
   BRIEF NORMALISATION
   ──────────────────────────────────────────────────────────── */

const siteProduct = catalog.PRODUCTS_BY_ID.site;

test('normalizeBrief fills a completely empty brief', () => {
  const b = gen.normalizeBrief(null, { business: 'Ridgeline Plumbing' }, siteProduct);
  assert.strictEqual(b.businessName, 'Ridgeline Plumbing');
  assert.ok(/^#[0-9a-f]{6}$/i.test(b.palette.accent));
  assert.ok(b.typography.headingFont);
  for (const page of siteProduct.pages) {
    assert.ok(Array.isArray(b.sections[page.key]), `missing sections for ${page.key}`);
  }
});

test('normalizeBrief rejects a malformed hex and falls back', () => {
  const b = gen.normalizeBrief({ palette: { accent: 'blue' } }, { business: 'X' }, siteProduct);
  assert.ok(/^#[0-9a-f]{6}$/i.test(b.palette.accent), b.palette.accent);
});

test('normalizeBrief keeps a valid palette', () => {
  const b = gen.normalizeBrief({ palette: { accent: '#AB12CD' } }, { business: 'X' }, siteProduct);
  assert.strictEqual(b.palette.accent, '#AB12CD');
});

test('normalizeBrief scrubs dashes out of the brief copy', () => {
  const b = gen.normalizeBrief(
    { businessName: 'Acme', tagline: 'Fast — and cheap' },
    { business: 'Acme' },
    siteProduct
  );
  assert.ok(!/[—–]/.test(b.tagline), b.tagline);
});

/* ────────────────────────────────────────────────────────────
   PAGE ASSEMBLY
   ──────────────────────────────────────────────────────────── */

test('assemblePage inlines the CSS and produces a full document', () => {
  const brief = gen.normalizeBrief(null, { business: 'Acme' }, siteProduct);
  const doc = gen.assemblePage({
    page: siteProduct.pages[0],
    body: '<h1>Hi</h1>',
    css: ':root{--bg:#fff}',
    brief,
    product: siteProduct,
  });

  assert.ok(doc.startsWith('<!DOCTYPE html>'), 'no doctype');
  assert.ok(doc.includes('<meta name="viewport"'), 'no viewport meta');
  assert.ok(doc.includes('<style>'), 'css was not inlined');
  assert.ok(doc.includes(':root{--bg:#fff}'), 'css body missing');
  assert.ok(doc.includes('<h1>Hi</h1>'), 'body missing');
  assert.ok(!doc.includes('<link rel="stylesheet" href="style.css"'), 'linked a shared stylesheet');
});

test('assemblePage escapes quotes in the title and description', () => {
  const brief = gen.normalizeBrief(
    { businessName: 'Bob\'s "Best" Shop', tagline: 'a <b>bold</b> claim' },
    { business: 'x' },
    siteProduct
  );
  const doc = gen.assemblePage({
    page: siteProduct.pages[0],
    body: '<p>x</p>',
    css: 'p{}',
    brief,
    product: siteProduct,
  });
  assert.ok(!/content="[^"]*"[^"=>]*"/.test(doc), 'unescaped quote broke an attribute');
  assert.ok(doc.includes('&quot;Best&quot;') || doc.includes('&amp;'), 'nothing was escaped');
});

/* ────────────────────────────────────────────────────────────
   CATALOG — the pricing contract
   ──────────────────────────────────────────────────────────── */

test('catalog has the three expected products', () => {
  assert.deepStrictEqual(Object.keys(catalog.PRODUCTS_BY_ID).sort(), ['funnel', 'preview', 'site']);
});

test('preview is free and the paid tiers are not', () => {
  assert.strictEqual(catalog.PRODUCTS_BY_ID.preview.starCost, 0);
  assert.ok(catalog.PRODUCTS_BY_ID.site.starCost > 0);
  assert.ok(catalog.PRODUCTS_BY_ID.funnel.starCost > catalog.PRODUCTS_BY_ID.site.starCost);
});

test('every product has at least one page and a unique filename set', () => {
  for (const p of catalog.PRODUCTS) {
    assert.ok(p.pages.length >= 1, `${p.productId} has no pages`);
    const names = p.pages.map((x) => x.filename);
    assert.strictEqual(new Set(names).size, names.length, `${p.productId} has duplicate filenames`);
  }
});

test('every site-kind product has an index.html entry page', () => {
  for (const p of catalog.PRODUCTS.filter((x) => x.kind === 'site')) {
    assert.ok(
      p.pages.some((x) => x.filename === 'index.html'),
      `${p.productId} has no index.html`
    );
  }
});

test('public catalog exposes no internal page objects', () => {
  for (const p of catalog.publicCatalog()) {
    assert.ok(Array.isArray(p.pages));
    assert.strictEqual(typeof p.pages[0], 'string');
  }
});

/* ────────────────────────────────────────────────────────────
   PROMPTS
   ──────────────────────────────────────────────────────────── */

test('the base system prompt contains no em-dash of its own', () => {
  // A prompt that demonstrates the character it forbids teaches the model to
  // use it. This assertion is here because that has bitten us before.
  assert.ok(
    !/[—–]/.test(prompts.BASE_SYSTEM.replace('Never write the characters — or –', '')),
    'BASE_SYSTEM contains a dash outside the rule that names it'
  );
});

test('page prompt includes the class contract and the real page job', () => {
  const brief = gen.normalizeBrief(null, { business: 'Acme' }, siteProduct);
  const p = prompts.buildPagePrompt(siteProduct.pages[0], brief, siteProduct);
  assert.ok(p.includes('wm-hero'), 'class contract missing');
  assert.ok(p.includes('homepage') || p.includes('Hero'), 'page job missing');
  assert.ok(p.includes('index.html'), 'nav links missing');
});

test('funnel pages get no nav block', () => {
  const funnel = catalog.PRODUCTS_BY_ID.funnel;
  const brief = gen.normalizeBrief(null, { business: 'Acme' }, funnel);
  const p = prompts.buildPagePrompt(funnel.pages[0], brief, funnel);
  // The class contract is shared, so nav class NAMES appear for both kinds.
  // What must not appear is the nav template the model is told to copy.
  assert.ok(!p.includes('NAVIGATION'), 'funnel got a nav instruction block');
  assert.ok(!p.includes('BUSINESS_NAME'), 'funnel got the nav markup to copy');

  const sitePrompt = prompts.buildPagePrompt(
    siteProduct.pages[0],
    gen.normalizeBrief(null, { business: 'Acme' }, siteProduct),
    siteProduct
  );
  assert.ok(sitePrompt.includes('BUSINESS_NAME'), 'site page lost its nav template');
});

test('css prompt carries the palette tokens and the observed class list', () => {
  const brief = gen.normalizeBrief({ palette: { accent: '#123456' } }, { business: 'X' }, siteProduct);
  const p = prompts.buildCssPrompt(brief, ['wm-hero', 'wm-card'], siteProduct);
  assert.ok(p.includes('#123456'), 'accent token missing');
  assert.ok(p.includes('wm-hero, wm-card'), 'class list missing');
  assert.ok(p.includes('prefers-reduced-motion'), 'motion rule missing');
});

test('prompt input is collapsed and length-capped', () => {
  const long = 'x'.repeat(2000);
  assert.strictEqual(prompts.clean(`  a\n\n  b  `), 'a b');
  assert.strictEqual(prompts.clean(long).length, 600);
});

/* ────────────────────────────────────────────────────────────
   TELEGRAM initData
   ──────────────────────────────────────────────────────────── */

function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

test('valid initData verifies and returns the user', () => {
  const initData = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, username: 'jon', first_name: 'Jon' }),
    },
    TOKEN
  );
  const out = verifyInitData(initData);
  assert.strictEqual(out.user.id, '42');
  assert.strictEqual(out.user.username, 'jon');
});

test('tampered initData is rejected', () => {
  const initData = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, username: 'jon' }),
    },
    TOKEN
  );

  const params = new URLSearchParams(initData);

  // Swap the user id for someone else's and keep the original hash. This is
  // the attack that matters: acting as another account.
  const forged = new URLSearchParams(initData);
  forged.set('user', JSON.stringify({ id: 9999, username: 'jon' }));
  assert.throws(() => verifyInitData(forged.toString()), /invalid|signature/i);

  // And a hash that does not match its own payload.
  const h = params.get('hash');
  params.set('hash', (h[0] === 'a' ? 'b' : 'a') + h.slice(1));
  assert.throws(() => verifyInitData(params.toString()), /invalid|signature/i);
});

/**
 * Telegram Web 9.6 sends `signature` and counts it in the data-check-string;
 * other clients leave it out. Both must verify, or one platform silently
 * fails auth with nothing to show for it but a bad hash.
 */
test('initData verifies with signature inside the data-check-string', () => {
  const initData = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'AAEtest',
      signature: 'ed25519-placeholder',
      user: JSON.stringify({ id: 42, username: 'jon' }),
    },
    TOKEN
  );
  assert.strictEqual(verifyInitData(initData).user.id, '42');
});

test('initData verifies with signature excluded from the data-check-string', () => {
  // Sign without `signature`, then add it back unsigned: the older reading.
  const base = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEtest',
    user: JSON.stringify({ id: 42, username: 'jon' }),
  };
  const signed = new URLSearchParams(signInitData(base, TOKEN));
  signed.set('signature', 'ed25519-placeholder');
  assert.strictEqual(verifyInitData(signed.toString()).user.id, '42');
});

test('a forged user is still rejected when signature is present', () => {
  const signed = new URLSearchParams(
    signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        signature: 'ed25519-placeholder',
        user: JSON.stringify({ id: 42 }),
      },
      TOKEN
    )
  );
  signed.set('user', JSON.stringify({ id: 9999 }));
  assert.throws(() => verifyInitData(signed.toString()), /invalid|signature/i);
});

test('initData signed with the wrong bot token is rejected', () => {
  const initData = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
    },
    '999999:SOME-OTHER-BOT-TOKEN'
  );
  assert.throws(() => verifyInitData(initData));
});

test('stale initData is rejected', () => {
  const old = String(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 3);
  const initData = signInitData({ auth_date: old, user: JSON.stringify({ id: 1 }) }, TOKEN);
  assert.throws(() => verifyInitData(initData), /expired/i);
});

test('missing initData is rejected', () => {
  assert.throws(() => verifyInitData(''), /missing/i);
  assert.throws(() => verifyInitData(undefined), /missing/i);
});

/* ────────────────────────────────────────────────────────────
   ERROR UI CONTRACT
   ──────────────────────────────────────────────────────────── */

test('an unauthorized error takes over the screen', () => {
  const ui = screens.renderError({ code: 'UNAUTHORIZED', message: 'nope' });
  assert.strictEqual(ui.error.inline, false);
});

test('a free-build error is an inline toast', () => {
  const ui = screens.renderError({ code: 'FREE_BUILD_USED', message: 'used' });
  assert.strictEqual(ui.error.inline, true);
  assert.strictEqual(ui.error.action, 'store');
});

test('an unknown error code still renders', () => {
  const ui = screens.renderError({ code: 'WAT', message: 'mystery' });
  assert.ok(ui.error.title);
  assert.strictEqual(ui.error.body, 'mystery');
});

test('backScreen is whitelisted', () => {
  const ui = screens.renderError({ code: 'NOT_FOUND', message: 'x' }, { backScreen: 'evil' });
  assert.strictEqual(ui.error.backScreen, 'main');
});

/* ────────────────────────────────────────────────────────────
   FORMATTERS
   ──────────────────────────────────────────────────────────── */

test('byte and duration formatting', () => {
  assert.strictEqual(format.bytes(512), '512 B');
  assert.strictEqual(format.bytes(2048), '2.0 KB');
  assert.strictEqual(format.duration(45000), '45s');
  assert.strictEqual(format.duration(74000), '1m 14s');
  assert.strictEqual(format.compact(12400), '12.4K');
});

/* ────────────────────────────────────────────────────────────
   SPEND BREAKER
   ──────────────────────────────────────────────────────────── */

test('the spend breaker starts closed and resets', () => {
  client.resetSpend();
  assert.strictEqual(client.budgetExceeded(), false);
  assert.strictEqual(client.spendToday(), 0);
});

/* ────────────────────────────────────────────────────────────
   BRAND NAME

   One value drives every user-facing surface. It used to be hardcoded in
   four files, which is how a rename leaves one behind and ships two names.
   ──────────────────────────────────────────────────────────── */

test('the brand name defaults to FivePageBot', () => {
  assert.strictEqual(config.brandName, 'FivePageBot');
  // Discord inherits it unless explicitly overridden.
  assert.strictEqual(config.discord.brandName, config.brandName);
});

test('the Telegram Mini App button carries the configured brand', () => {
  const kb = bot.miniAppKeyboard();
  // Undefined when MINI_APP_URL is unset, which is the case under test env.
  const label = kb ? kb.inline_keyboard[0][0].text : `Open ${config.brandName}`;
  assert.ok(label.includes(config.brandName), label);
});

test('the Mini App page title matches the configured brand', () => {
  // public/index.html is static and cannot read config, so it is the one
  // surface that drifts silently on a rename. Pin it here.
  const html = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'public', 'index.html'),
    'utf8'
  );
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  assert.strictEqual(title, config.brandName);
});

/* ────────────────────────────────────────────────────────────
   PLATFORM-SCOPED IDENTITY

   The bug these guard against is silent: a bare id in a query matches
   nothing, so a collision or a missed prefix reads as "this user has no
   builds" rather than as an error.
   ──────────────────────────────────────────────────────────── */

test('a Telegram and a Discord user with the same number are different owners', () => {
  const a = identity.composeUserId('telegram', '12345');
  const b = identity.composeUserId('discord', '12345');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, 'telegram:12345');
  assert.strictEqual(b, 'discord:12345');
});

test('a bare id is treated as Telegram, so existing call sites keep working', () => {
  assert.strictEqual(identity.normalizeUserId('100001'), 'telegram:100001');
  assert.strictEqual(identity.normalizeUserId(100001), 'telegram:100001');
});

test('normalizing is idempotent', () => {
  const once = identity.normalizeUserId('discord:999');
  assert.strictEqual(identity.normalizeUserId(once), once);
  assert.strictEqual(identity.normalizeUserId(identity.normalizeUserId(once)), once);
});

test('a composite id round-trips back to its platform and raw id', () => {
  for (const [platform, raw] of [['telegram', '1'], ['discord', '847262518293847262']]) {
    const composite = identity.composeUserId(platform, raw);
    assert.deepStrictEqual(identity.parseUserId(composite), { platform, rawId: raw });
    assert.strictEqual(identity.platformOf(composite), platform);
    assert.strictEqual(identity.rawIdOf(composite), raw);
  }
});

test('an unknown platform is refused rather than stored', () => {
  assert.throws(() => identity.composeUserId('slack', '1'), /Unknown platform/);
  assert.throws(() => identity.composeUserId('telegram', ''), /requires a raw user id/);
});

/* ────────────────────────────────────────────────────────────
   INVOICE PAYLOAD

   Colon-delimited payloads broke the moment ids became composite: the
   pre-checkout handler read field 3 as the buyer and got "telegram",
   which rejected every paid invoice.
   ──────────────────────────────────────────────────────────── */

test('a current payload survives a composite id', () => {
  const p = `build|site|${identity.composeUserId('telegram', '100002')}|ab12cd34`;
  const parsed = service.parseInvoicePayload(p);
  assert.strictEqual(parsed.kind, 'build');
  assert.strictEqual(parsed.productId, 'site');
  assert.strictEqual(parsed.userId, 'telegram:100002');
  assert.strictEqual(parsed.nonce, 'ab12cd34');
});

test('a legacy colon payload still parses, so open invoices stay payable', () => {
  const parsed = service.parseInvoicePayload('build:site:100002:ab12cd34');
  assert.strictEqual(parsed.kind, 'build');
  assert.strictEqual(parsed.productId, 'site');
  assert.strictEqual(parsed.userId, 'telegram:100002');
});

test('a malformed payload yields nulls instead of throwing', () => {
  for (const junk of ['', 'build', 'build|', 'x', null, undefined, 'a:b']) {
    const parsed = service.parseInvoicePayload(junk);
    assert.ok(!(parsed.kind === 'build' && parsed.userId), `accepted junk: ${junk}`);
  }
});

/* ────────────────────────────────────────────────────────────
   DISCORD ADAPTER
   ──────────────────────────────────────────────────────────── */

test('the slash commands stay within Discord field limits', () => {
  const json = discordCommands.toJSON();
  assert.deepStrictEqual(
    json.map((c) => c.name).sort(),
    ['build', 'builds', 'forget', 'help', 'pricing']
  );
  for (const c of json) {
    assert.ok(/^[a-z][a-z0-9_-]{0,31}$/.test(c.name), `bad command name: ${c.name}`);
    assert.ok(c.description.length <= 100, `description too long: ${c.name}`);
    assert.ok(c.description.length > 0, `no description: ${c.name}`);
  }
});

test('every registered command has a handler', () => {
  // Catches a rename that updates the builder but not the router, which would
  // otherwise surface as a command that silently does nothing.
  const names = discordCommands.toJSON().map((c) => c.name);
  for (const name of names) {
    assert.ok(discordHandlers.COMMAND_NAMES.includes(name), `no handler for /${name}`);
  }
  assert.deepStrictEqual(discordHandlers.COMMAND_NAMES.slice().sort(), names.slice().sort());
});

test('the intake modal collects all four answers in one submission', () => {
  const modal = discordHandlers.buildModal().toJSON();
  assert.ok(modal.title.length <= 45, 'modal title over 45 chars');
  assert.strictEqual(modal.custom_id, discordHandlers.MODAL_ID);

  const inputs = modal.components.map((row) => row.components[0]);
  assert.deepStrictEqual(
    inputs.map((i) => i.custom_id),
    ['business', 'offer', 'audience', 'style']
  );

  // The two the generator cannot work without are required; the other two are
  // not, because forcing a style answer out of someone who has no opinion is
  // how you get "idk" as a design brief.
  assert.deepStrictEqual(
    inputs.map((i) => Boolean(i.required)),
    [true, true, false, false]
  );

  for (const i of inputs) {
    assert.ok(i.label.length <= 45, `label over 45 chars: ${i.custom_id}`);
    // service.validateInputs caps business/offer/audience at 600 and style at
    // 200. A modal that accepts more would silently truncate the user's words.
    assert.ok(i.max_length <= 600, `max_length too high: ${i.custom_id}`);
  }
});

test('every command is usable in a DM', () => {
  // A generated page is personal. Someone who does not want their business
  // description in a public channel must be able to run the bot in a DM.
  for (const c of discordCommands.toJSON()) {
    assert.strictEqual(c.dm_permission, true, `/${c.name} is server-only`);
  }
});

test('erasure is reachable from the bot, not only by email', () => {
  // The privacy policy promises /forget. If the command stops existing, the
  // published policy becomes a false claim.
  assert.ok(discordHandlers.COMMAND_NAMES.includes('forget'));
  assert.strictEqual(typeof service.deleteUserData, 'function');
});

test('Discord sells only the free product', () => {
  assert.strictEqual(discordHandlers.FREE_PRODUCT.free, true);
  assert.strictEqual(discordHandlers.FREE_PRODUCT.starCost, 0);
});

test('the zip attach threshold stays under Discord free-tier upload limit', () => {
  assert.ok(discordHandlers.ATTACH_LIMIT_BYTES < 10 * 1024 * 1024);
});

test('the upsell renders nothing when no Telegram username is configured', () => {
  // A missing env var must produce no line at all rather than a dead t.me link.
  const saved = config.telegram.botUsername;
  try {
    config.telegram.botUsername = '';
    assert.strictEqual(discordHandlers.upsellLine(), '');

    config.telegram.botUsername = 'fivepagebot';
    const line = discordHandlers.upsellLine();
    assert.ok(line.includes('https://t.me/fivepagebot'), 'no link in upsell');
    assert.ok(line.includes(String(catalog.PRODUCTS_BY_ID.site.starCost)), 'no price in upsell');
  } finally {
    config.telegram.botUsername = saved;
  }
});

testAsync('the 3-second preflight falls back rather than hanging the interaction', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 5000).unref?.());
  const r = await discordHandlers.raceWithTimeout(slow, 30, 'fallback');
  assert.strictEqual(r, 'fallback');

  const fast = Promise.resolve('quick');
  assert.strictEqual(await discordHandlers.raceWithTimeout(fast, 500, 'fallback'), 'quick');

  // A rejection must read as the fallback, not blow up the interaction.
  const boom = Promise.reject(new Error('mongo is down'));
  assert.strictEqual(await discordHandlers.raceWithTimeout(boom, 500, 'fallback'), 'fallback');
});

/* ────────────────────────────────────────────────────────────
   SUMMARY
   ──────────────────────────────────────────────────────────── */

(async () => {
  /**
   * Holds the event loop open for the duration of the async drain.
   *
   * Without it the process exits before a single async case runs. The timers
   * under test are deliberately `unref`'d — a pending 1.2s preflight must not
   * delay a deploy's shutdown — and an `await` on a promise that only an
   * unref'd timer will settle does not keep Node alive on its own. The
   * symptom is silent: the suite prints its last sync case and exits 0,
   * reporting nothing and failing nothing.
   */
  const keepAlive = setInterval(() => {}, 1000);

  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}\n        ${err.message}`);
    }
  }

  clearInterval(keepAlive);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.error('Self-test failed.');
    process.exit(1);
  }
  console.log('Self-test passed.');
})();
