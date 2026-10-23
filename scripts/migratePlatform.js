'use strict';

/**
 * Backfills composite user ids.
 *
 * Before: userId was a bare Telegram id ("12345").
 * After:  userId is "<platform>:<rawId>" ("telegram:12345"), plus a
 *         denormalized `platform` field.
 *
 * Every existing row is Telegram by definition — Discord did not exist when
 * they were written.
 *
 * Idempotent: a row that already carries a known platform prefix is skipped,
 * so running this twice is harmless and a half-finished run can be resumed.
 *
 *   node scripts/migratePlatform.js --dry     # report only, writes nothing
 *   node scripts/migratePlatform.js           # apply
 *
 * Run it BEFORE deploying the Discord adapter. Until it runs, the Telegram
 * bot normalizes "12345" to "telegram:12345" and finds no row — every
 * existing user silently looks brand new, with a fresh free-build quota and
 * no build history.
 */

const { connectDb, disconnectDb } = require('../src/db/connect');
const { PLATFORMS, DEFAULT_PLATFORM } = require('../src/utils/identity');
const User = require('../src/models/User');
const Site = require('../src/models/Site');
const Transaction = require('../src/models/Transaction');

const DRY = process.argv.includes('--dry');

/** Already-composite ids are left alone. */
const COMPOSITE = new RegExp(`^(${PLATFORMS.join('|')}):`);

async function migrateCollection(Model, label) {
  const docs = await Model.find({}, { userId: 1, platform: 1 }).lean();

  let moved = 0;
  let skipped = 0;
  let tagged = 0;
  const conflicts = [];

  for (const doc of docs) {
    const current = String(doc.userId ?? '');
    const needsPrefix = current && !COMPOSITE.test(current);
    const needsPlatform = !doc.platform;

    if (!needsPrefix && !needsPlatform) {
      skipped += 1;
      continue;
    }

    const next = needsPrefix ? `${DEFAULT_PLATFORM}:${current}` : current;

    if (!DRY) {
      try {
        await Model.updateOne(
          { _id: doc._id },
          { $set: { userId: next, platform: DEFAULT_PLATFORM } }
        );
      } catch (err) {
        // E11000 means a composite row for this id already exists — which
        // happens if the new code was deployed BEFORE this migration ran, so
        // a returning user was created fresh as "telegram:<id>" alongside
        // their original bare row.
        //
        // Merging the two means reconciling lifetime counters, the free-build
        // window and a referral code, and guessing wrong silently hands
        // someone a second free build or orphans their history. So: skip,
        // keep going, and report it. Half a migration that tells you what it
        // could not do beats one that dies on row 400 of 900.
        if (err.code === 11000) {
          conflicts.push({ id: doc._id.toString(), from: current, to: next });
          continue;
        }
        throw err;
      }
    }

    if (needsPrefix) moved += 1;
    else tagged += 1;
  }

  console.log(
    `  ${label.padEnd(14)} ${String(docs.length).padStart(6)} rows   ` +
      `${String(moved).padStart(5)} re-keyed   ` +
      `${String(tagged).padStart(5)} tagged only   ` +
      `${String(skipped).padStart(5)} already done` +
      (conflicts.length ? `   ${String(conflicts.length).padStart(4)} CONFLICT` : '')
  );

  return { total: docs.length, moved, tagged, skipped, conflicts, label };
}

async function main() {
  await connectDb();

  console.log(`\n${DRY ? '── DRY RUN (nothing will be written) ──' : '── APPLYING ──'}\n`);

  const users = await migrateCollection(User, 'users');
  const sites = await migrateCollection(Site, 'sites');
  const txs = await migrateCollection(Transaction, 'transactions');

  // Referral pointers hold a bare userId too, and nothing normalizes them on
  // read — an un-prefixed referredBy would point at an id that no longer
  // exists, quietly orphaning the referral graph.
  const referred = await User.find(
    { referredBy: { $ne: null } },
    { referredBy: 1 }
  ).lean();

  let refFixed = 0;
  for (const doc of referred) {
    const current = String(doc.referredBy);
    if (COMPOSITE.test(current)) continue;
    if (!DRY) {
      await User.updateOne(
        { _id: doc._id },
        { $set: { referredBy: `${DEFAULT_PLATFORM}:${current}` } }
      );
    }
    refFixed += 1;
  }
  console.log(
    `  ${'referredBy'.padEnd(14)} ${String(referred.length).padStart(6)} rows   ` +
      `${String(refFixed).padStart(5)} re-pointed`
  );

  const touched = users.moved + sites.moved + txs.moved + refFixed;

  console.log(`\n${DRY ? 'Would change' : 'Changed'} ${touched} id${touched === 1 ? '' : 's'}.`);

  const allConflicts = [users, sites, txs].filter((r) => r.conflicts?.length);

  if (allConflicts.length) {
    console.log('\n── CONFLICTS — these rows were NOT migrated ──\n');
    for (const r of allConflicts) {
      for (const c of r.conflicts) {
        console.log(`  ${r.label.padEnd(14)} ${c.from}  →  ${c.to}   (_id ${c.id})`);
      }
    }
    console.log(
      [
        '',
        'A composite row already exists for each id above, which means the new',
        'code was deployed before this migration ran and those users were',
        'recreated from scratch. Each pair needs a decision about whose',
        'counters, free-build window and referral code survive.',
        '',
        'Everything else migrated. Re-running is safe and will skip the rest.',
        '',
      ].join('\n')
    );
    await disconnectDb();
    process.exitCode = 1;
    return;
  }

  if (DRY && touched > 0) console.log('Re-run without --dry to apply.\n');
  else console.log('');

  await disconnectDb();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
