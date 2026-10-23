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

/** Owners are you. Counting yourself as traction is how you fool yourself. */
function ownerIds() {
  return new Set(
    config.ownerIds.map((id) => (id.includes(':') ? id : `telegram:${id}`))
  );
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

  console.log('\n═══ BUILDS ══════════════════════════════════════════════\n');
  console.log(row('Attempted', sites, sites));
  console.log(row('…succeeded', ready, sites));
  console.log(row('…failed', failed, sites));
  console.log(row('…stuck generating', stuck, sites));
  if (owners.size) {
    console.log(row('…by someone who is not you', strangerSites, sites));
  }

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

  /* ---- the read -------------------------------------------------------- */
  console.log('\n═══ THE READ ════════════════════════════════════════════\n');

  if (strangers === 0 && owners.size) {
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

  console.log('');
  await disconnectDb();
}

main().catch((err) => {
  console.error('usage.js failed:', err.message);
  process.exit(1);
});
