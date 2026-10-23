#!/usr/bin/env node
'use strict';

/**
 * Who is actually using this.
 *
 *   npm run usage
 *   railway run npm run usage     # against production
 *
 * Read-only. Never writes.
 *
 * `db:check` answers "can I connect". This answers the question that decides
 * what to do next: are strangers arriving, and where do they stop?
 *
 * The number that matters most is invoices-created versus invoices-paid. A
 * pending transaction only exists because someone tapped a buy button, so it
 * separates "nobody wanted it" from "someone wanted it and checkout lost
 * them" — two problems with completely different fixes.
 */

require('dotenv').config();

const { connectDb, disconnectDb } = require('../src/db/connect');
const User = require('../src/models/User');
const Site = require('../src/models/Site');
const Transaction = require('../src/models/Transaction');
const { PRODUCTS_BY_ID } = require('../src/catalog/products');
const config = require('../src/config');

const pct = (n, of) => (of === 0 ? '   — ' : `${((n / of) * 100).toFixed(0).padStart(4)}%`);
const row = (label, n, of) => `  ${label.padEnd(34)} ${String(n).padStart(6)}  ${pct(n, of)}`;

/**
 * Owners are you. Counting yourself as traction is how you fool yourself.
 *
 * Falls back to reading OWNER_IDS directly, so this script still runs against
 * a deploy whose config predates the owner-exemption feature. A reporting
 * tool that crashes because one optional field is missing is worse than one
 * that reports slightly less.
 */
function ownerIds() {
  const raw = Array.isArray(config.ownerIds)
    ? config.ownerIds
    : String(process.env.OWNER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  return new Set(raw.map((id) => (id.includes(':') ? id : `telegram:${id}`)));
}

async function main() {
  await connectDb();

  const owners = ownerIds();
  const ownerFilter = owners.size ? { userId: { $nin: [...owners] } } : {};

  /* ---- who ----------------------------------------------------------- */
  const users = await User.countDocuments();
  const tgUsers = await User.countDocuments({ platform: 'telegram' });
  const dcUsers = await User.countDocuments({ platform: 'discord' });
  const strangers = await User.countDocuments(ownerFilter);

  console.log('\n═══ PEOPLE ══════════════════════════════════════════════\n');
  console.log(row('Everyone who has touched a bot', users, users));
  console.log(row('…on Telegram', tgUsers, users));
  console.log(row('…on Discord', dcUsers, users));
  if (owners.size) {
    console.log(row('…who are not you', strangers, users));
  }

  /* ---- builds --------------------------------------------------------- */
  const sites = await Site.countDocuments();
  const ready = await Site.countDocuments({ status: 'ready' });
  const failed = await Site.countDocuments({ status: 'failed' });
  const stuck = await Site.countDocuments({ status: 'generating' });
  const strangerSites = await Site.countDocuments(ownerFilter);

  /**
   * Reliability is a question about NOW, not about lifetime.
   *
   * A migration you debugged for half an hour last week leaves a permanent
   * dent in the lifetime rate. Reported as current, it sends you to fix
   * something you already fixed — which is worse than reporting nothing.
   */
  const RECENT_DAYS = 7;
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const recentSites = await Site.countDocuments({ createdAt: { $gte: since } });
  const recentFailed = await Site.countDocuments({
    status: 'failed',
    createdAt: { $gte: since },
  });

  console.log('\n═══ BUILDS ══════════════════════════════════════════════\n');
  console.log(row('Attempted', sites, sites));
  console.log(row('…succeeded', ready, sites));
  console.log(row('…failed', failed, sites));
  console.log(row('…stuck generating', stuck, sites));
  if (owners.size) {
    console.log(row('…by someone who is not you', strangerSites, sites));
  }
  console.log('');
  console.log(row(`Attempted in the last ${RECENT_DAYS} days`, recentSites, recentSites));
  console.log(row('…failed', recentFailed, recentSites));

  /* ---- money ---------------------------------------------------------- */
  const invoices = await Transaction.countDocuments({ kind: 'stars_purchase' });
  const paid = await Transaction.countDocuments({
    kind: 'stars_purchase',
    status: { $in: ['paid', 'fulfilled', 'refunded'] },
  });
  const fulfilled = await Transaction.countDocuments({ status: 'fulfilled' });
  const refunded = await Transaction.countDocuments({ status: 'refunded' });

  const earned = await Transaction.aggregate([
    { $match: { status: { $in: ['paid', 'fulfilled'] } } },
    { $group: { _id: null, stars: { $sum: '$stars' } } },
  ]);
  const stars = earned[0]?.stars || 0;

  console.log('\n═══ MONEY ═══════════════════════════════════════════════\n');
  console.log(row('Invoices created (tapped buy)', invoices, invoices));
  console.log(row('…paid', paid, invoices));
  console.log(row('…delivered', fulfilled, invoices));
  console.log(row('…refunded', refunded, invoices));
  console.log(`\n  Stars held (net of refunds)        ${String(stars).padStart(6)} ⭐  ≈ $${Math.round(stars * 0.013)}`);

  /* ---- by product ----------------------------------------------------- */
  console.log('\n═══ BY PRODUCT ══════════════════════════════════════════\n');
  for (const id of Object.keys(PRODUCTS_BY_ID)) {
    const p = PRODUCTS_BY_ID[id];
    const built = await Site.countDocuments({ productId: id, status: 'ready' });
    const sold = await Transaction.countDocuments({
      productId: id,
      status: { $in: ['paid', 'fulfilled'] },
    });
    console.log(`  ${p.name.padEnd(18)} built ${String(built).padStart(5)}   sold ${String(sold).padStart(4)}`);
  }

  /* ---- arrivals ------------------------------------------------------- */
  const byDay = await User.aggregate([
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    { $sort: { _id: -1 } },
    { $limit: 14 },
  ]);

  console.log('\n═══ NEW PEOPLE, LAST 14 DAYS ════════════════════════════\n');
  if (!byDay.length) {
    console.log('  (none)');
  } else {
    for (const d of byDay.reverse()) {
      console.log(`  ${d._id}  ${'█'.repeat(Math.min(d.n, 40))} ${d.n}`);
    }
  }

  /* ---- why builds failed ---------------------------------------------- */
  if (failed > 0) {
    const reasons = await Site.aggregate([
      { $match: { status: 'failed' } },
      { $group: { _id: '$error', n: { $sum: 1 }, last: { $max: '$createdAt' } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]);

    console.log('\n═══ WHY BUILDS FAILED ═══════════════════════════════════\n');
    for (const r of reasons) {
      const when = r.last ? new Date(r.last).toISOString().slice(0, 16).replace('T', ' ') : '';
      console.log(`  ${String(r.n).padStart(3)} ×  ${String(r._id || '(no error recorded)').slice(0, 90)}`);
      console.log(`        last: ${when}`);
    }

    // Truncation is logged as a note rather than an error, so a build can
    // "succeed" with a half-written stylesheet. Surfaced here because it is
    // the same underlying problem as an outright failure: the model ran out
    // of room.
    const truncated = await Site.countDocuments({
      generationNotes: { $elemMatch: { $regex: 'token limit|truncated', $options: 'i' } },
    });
    if (truncated) {
      console.log(`\n  ${String(truncated).padStart(3)} ×  builds that SUCCEEDED but hit the token limit`);
    }
  }

  /* ---- the read -------------------------------------------------------- */
  console.log('\n═══ THE READ ════════════════════════════════════════════\n');

  // Reliability first. A generator that fails two builds in three makes every
  // other number meaningless — there is no point reading a funnel whose top
  // is handing people errors.
  if (recentSites >= 5 && recentFailed / recentSites > 0.2) {
    const rate = Math.round((recentFailed / recentSites) * 100);
    console.log(`  ${rate}% of builds have FAILED in the last ${RECENT_DAYS} days.`);
    console.log('  Fix this before anything else — every second person who tries');
    console.log('  is getting nothing, and no traffic survives that.');
  } else if (failed / Math.max(sites, 1) > 0.2 && recentFailed === 0) {
    const rate = Math.round((failed / sites) * 100);
    console.log(`  ${rate}% of builds failed all-time, but NONE in the last`);
    console.log(`  ${RECENT_DAYS} days. That is a dent from a past incident, not a`);
    console.log('  live problem. Check the dates above before acting on it.');
  } else if (strangers === 0 && owners.size) {
    console.log('  Nobody but you has run this yet. Nothing about the product');
    console.log('  is disproven — it has not been seen. The constraint is');
    console.log('  distribution, and no amount of code changes that.');
  } else if (users < 25) {
    console.log('  Too few people to judge the offer. Keep posting; come back');
    console.log('  to this when a hundred people have seen it.');
  } else if (invoices === 0) {
    console.log('  People arrive and build, but nobody taps buy. They have seen');
    console.log('  your output and said no. That is an offer problem, not a');
    console.log('  traffic problem — more traffic reproduces it faster.');
  } else if (paid / invoices < 0.5) {
    console.log('  People tap buy and do not finish paying. Check the');
    console.log('  pre-checkout rejection logs before changing anything else.');
  } else if (sites > 0 && failed / sites > 0.1) {
    console.log('  Builds fail often enough to cost you trust. Fix generation');
    console.log('  before buying attention.');
  } else {
    console.log('  The funnel converts. The constraint is volume at the top.');
  }

  const stillTruncating = await Site.countDocuments({
    createdAt: { $gte: since },
    generationNotes: { $elemMatch: { $regex: 'token limit|truncated', $options: 'i' } },
  });
  if (stillTruncating) {
    console.log('');
    console.log(`  ${stillTruncating} recent build(s) hit the token limit and shipped`);
    console.log('  truncated. Those pass as successes but deliver a half-written');
    console.log('  stylesheet. Raise CLAUDE_MAX_TOKENS.');
  }

  console.log('');
  await disconnectDb();
}

main().catch((err) => {
  console.error('usage.js failed:', err.message);
  process.exit(1);
});
