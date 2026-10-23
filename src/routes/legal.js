'use strict';

/**
 * TERMS AND PRIVACY
 *
 * Served from this server so Discord's "Terms of Service URL" and "Privacy
 * Policy URL" fields have somewhere real to point, with no second host to
 * deploy and no static site to keep in sync.
 *
 * The text is written from what the code actually does — the fields on
 * User, Site and Transaction, the third parties those fields reach, and what
 * `service.deleteUserData` really erases. If you change what is stored, change
 * this page in the same commit.
 *
 * Not legal advice, and not reviewed by a lawyer. It is an accurate
 * description of the system's behaviour, which is the part software can be
 * responsible for.
 */

const express = require('express');
const config = require('../config');

const router = express.Router();

const BRAND = config.brandName;
const ENTITY = config.legal.entity;
const UPDATED = config.legal.updated;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const contactLine = () =>
  config.legal.contactEmail
    ? `<a href="mailto:${esc(config.legal.contactEmail)}">${esc(config.legal.contactEmail)}</a>`
    : `a message to ${esc(BRAND)} on Discord or Telegram`;

/**
 * One self-contained page. Styles are inlined for the same reason the
 * generated sites inline theirs: the file works on its own, with no second
 * request and nothing to 404.
 */
function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(BRAND)}</title>
<meta name="description" content="${esc(title)} for ${esc(BRAND)}.">
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #5b6270;
    --line: #e4e7ec; --accent: #1668ff; --card: #f7f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0d0f14; --fg: #e9ecf1; --muted: #99a1b3;
      --line: #232733; --accent: #5b9dff; --card: #151924;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0d0f14; --fg: #e9ecf1; --muted: #99a1b3;
    --line: #232733; --accent: #5b9dff; --card: #151924;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 16px 96px; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 36px; }
  .brand { font-weight: 700; letter-spacing: -0.02em; color: var(--accent); text-decoration: none; }
  h1 { font-size: 2rem; line-height: 1.2; letter-spacing: -0.02em; margin: 14px 0 6px; }
  h2 { font-size: 1.15rem; letter-spacing: -0.01em; margin: 38px 0 10px; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); font-size: 0.9rem; }
  ul { padding-left: 22px; }
  li { margin: 7px 0; }
  code {
    background: var(--card); border: 1px solid var(--line); border-radius: 5px;
    padding: 1px 6px; font-size: 0.88em;
  }
  .box {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px 20px; margin: 22px 0;
  }
  a { color: var(--accent); }
  footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid var(--line); }
  @media (max-width: 480px) { .wrap { padding-top: 32px; } h1 { font-size: 1.6rem; } }
</style>
</head>
<body>
<div class="wrap">
<header>
  <a class="brand" href="/">${esc(BRAND)}</a>
  <h1>${esc(title)}</h1>
  <p class="muted">Last updated ${esc(UPDATED)}</p>
</header>
${bodyHtml}
<footer class="muted">
  <p>${esc(BRAND)} is operated by ${esc(ENTITY)}.
  <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
</footer>
</div>
</body>
</html>`;
}

/* ────────────────────────────────────────────────────────────
   TERMS
   ──────────────────────────────────────────────────────────── */

const TERMS = `
<p>${esc(BRAND)} generates web pages from a short description you provide. By
using the bot on Discord or Telegram, you agree to what follows.</p>

<h2>What you get</h2>
<ul>
  <li>The free tier generates one page per day, per person.</li>
  <li>Paid tiers, available on Telegram, generate a five-page website or a
      five-page sales funnel.</li>
  <li>Output arrives as a <code>.zip</code> and a preview link.</li>
</ul>

<h2>The pages are yours</h2>
<p>You own the output. Use it commercially, edit it, host it anywhere, with no
attribution required. ${esc(ENTITY)} claims no rights over pages generated for
you, and no exclusivity is implied — the same description may produce similar
pages for someone else.</p>

<h2>What you put in</h2>
<p>You are responsible for the business description you submit, and you confirm
you have the right to use it. Do not submit anyone else's confidential
information, and do not use ${esc(BRAND)} to produce content that is illegal,
deceptive, or impersonates a real person or organisation.</p>

<h2>The output is a starting point</h2>
<div class="box">
  <p><strong>Read the page before you publish it.</strong> It is machine
  generated and may contain errors, wrong claims about your business, or
  placeholder links. Prices, guarantees, contact details and legal text in a
  generated page are not verified by anyone.</p>
</div>
<p>Generated pages are delivered as-is. ${esc(ENTITY)} is not liable for losses
arising from publishing or relying on them.</p>

<h2>Preview links are public</h2>
<p>Each build gets a preview URL containing a long random slug. The slug is the
only credential — anyone holding the link can open the page, and search engines
may index it if you share it publicly. Treat a preview link as public. Delete
the build with <code>/forget</code> to kill its links.</p>

<h2>Availability and limits</h2>
<ul>
  <li>Generation is rate limited per person, and pauses entirely when the
      daily generation budget is reached.</li>
  <li>Service may be interrupted, changed, or discontinued without notice.</li>
  <li>Automated or bulk use, resale of the free tier, and attempts to
      circumvent the daily limit are not permitted.</li>
</ul>

<h2>Refunds</h2>
<p>Paid builds on Telegram are refundable on request through
<code>/refund</code>, with no questions asked. A build that fails to generate is
refunded automatically. Telegram allows refunds for a limited window after
purchase; beyond it, refunds are not technically possible.</p>

<h2>Changes</h2>
<p>These terms may change. Continued use after a change means you accept the
updated version. The date at the top reflects the current revision.</p>

<h2>Contact</h2>
<p>Questions about these terms: ${contactLine()}.</p>
`;

/* ────────────────────────────────────────────────────────────
   PRIVACY
   ──────────────────────────────────────────────────────────── */

const PRIVACY = `
<p>This describes exactly what ${esc(BRAND)} stores, why, and who else sees it.
It is written from the data the software actually records, not from a
template.</p>

<h2>What is stored</h2>
<p><strong>Your account</strong> — your Discord or Telegram numeric user id,
your username and display name, your language setting, and counts of how many
builds you have made. The id is how your builds are found again.</p>

<p><strong>What you type</strong> — the four answers you give the bot: what the
business is, what it sells, who buys it, and any style preference. These are
stored with the build they produced.</p>

<p><strong>What was generated</strong> — the full text of every page made for
you, kept so you can download it again later.</p>

<p><strong>Payments (Telegram only)</strong> — the amount, the product, a
payment identifier from Telegram, and the status. <strong>Card and bank details
are never seen by ${esc(BRAND)}</strong>; Telegram handles payment entirely and
passes back only a reference.</p>

<p><strong>Referrals</strong> — a random referral code, and the id of whoever
referred you, if anyone.</p>

<p>No analytics, advertising, or third-party tracking is used. Network
addresses are processed transiently for rate limiting and are not retained.</p>

<h2>Who else receives it</h2>
<ul>
  <li><strong>Anthropic</strong> — your four answers are sent to the Claude API
      to generate the page. They are not sent anywhere else.</li>
  <li><strong>Discord</strong> and <strong>Telegram</strong> — the platforms
      carrying the conversation, each under its own privacy policy.</li>
  <li><strong>Hosting and database providers</strong> — infrastructure
      operators who store the data on ${esc(ENTITY)}'s behalf.</li>
</ul>
<p>Your data is not sold, rented, or shared with anyone else.</p>

<h2>Preview links are public</h2>
<div class="box">
  <p>Each build is reachable at a URL containing a long random slug, and that
  slug is the only thing protecting it. Anyone you send the link to can open
  the page, and so can anyone they forward it to. <strong>Do not put anything
  private into a page you intend to share.</strong></p>
</div>

<h2>How long it is kept</h2>
<p>Builds and the text you typed are kept until you delete them. Payment
records are kept longer, as financial records.</p>

<h2>Deleting your data</h2>
<p>Run <code>/forget</code> in either bot. On Discord this asks you to confirm
with a button; on Telegram, send <code>/forget confirm</code>. It then:</p>
<ul>
  <li><strong>Deletes every build</strong> you have made, including the pages
      and the description you typed. Preview links stop working immediately.</li>
  <li><strong>Clears your username and display name.</strong></li>
  <li><strong>Strips payment records</strong> of anything you wrote, keeping
      only the amount, status and reference needed as a financial record and to
      honour a refund you may still be owed.</li>
  <li><strong>Keeps your build counts.</strong> Deleting the account entirely
      would reset the daily free-build limit, so the counters stay. They are
      numbers with no name attached.</li>
</ul>
<p>This cannot be undone. Download anything you want to keep first.</p>

<h2>Children</h2>
<p>${esc(BRAND)} is not directed at children, and follows the minimum age set by
Discord and Telegram for their platforms.</p>

<h2>Changes</h2>
<p>If what is stored changes, this page changes with it, and the date at the top
is updated.</p>

<h2>Contact</h2>
<p>Questions, or a request to access or delete data you cannot reach through
<code>/forget</code>: ${contactLine()}.</p>
`;

/* ────────────────────────────────────────────────────────────
   ROUTES
   ──────────────────────────────────────────────────────────── */

function send(res, title, body) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(page(title, body));
}

router.get('/terms', (req, res) => send(res, 'Terms of Service', TERMS));
router.get('/privacy', (req, res) => send(res, 'Privacy Policy', PRIVACY));

// Aliases, so a link written from memory still lands.
router.get('/terms-of-service', (req, res) => res.redirect(301, '/terms'));
router.get('/privacy-policy', (req, res) => res.redirect(301, '/privacy'));

module.exports = router;
