#!/usr/bin/env node
'use strict';

/**
 * Validates MONGODB_URI and proves the connection works.
 *
 *   npm run db:check
 *
 * Run this before pasting the string into Railway. The three things that
 * actually go wrong with an Atlas URI are all silent in production: a missing
 * database name writes to the wrong place, an unencoded password character
 * reads as an authentication failure, and a closed network allowlist looks
 * like a hung deploy. This names which one it is.
 */

require('dotenv').config();

const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI;
const problems = [];
const warnings = [];

function line(label, value) {
  console.log(`  ${label.padEnd(18)}${value}`);
}

console.log('\nMongoDB connection check\n');

/* ────────────────────────────────────────────────────────────
   1. STATIC CHECKS — before we dial anything
   ──────────────────────────────────────────────────────────── */

if (!uri) {
  console.error('  MONGODB_URI is not set.\n');
  console.error('  Put it in .env, or export it, then run this again.\n');
  process.exit(1);
}

const scheme = uri.startsWith('mongodb+srv://')
  ? 'mongodb+srv'
  : uri.startsWith('mongodb://')
    ? 'mongodb'
    : null;

if (!scheme) {
  problems.push('The URI does not start with mongodb:// or mongodb+srv://');
}

// Split the URI by hand. new URL() mangles mongodb+srv and hides the very
// characters we are here to inspect.
const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
const atIndex = afterScheme.lastIndexOf('@');

let userInfo = '';
let hostAndPath = afterScheme;

if (atIndex !== -1) {
  userInfo = afterScheme.slice(0, atIndex);
  hostAndPath = afterScheme.slice(atIndex + 1);
}

const [hostPart, ...rest] = hostAndPath.split('?');
const query = rest.join('?');
const slashIndex = hostPart.indexOf('/');

const host = slashIndex === -1 ? hostPart : hostPart.slice(0, slashIndex);
const dbName = slashIndex === -1 ? '' : hostPart.slice(slashIndex + 1);

const [username, ...pwParts] = userInfo.split(':');
const password = pwParts.join(':');

line('scheme', scheme || '(unrecognised)');
line('host', host || '(none)');
line('username', username || '(none)');
line('password', password ? `${password.length} characters` : '(none)');
line('database', dbName || '(NONE)');
line('options', query || '(none)');
console.log('');

/* ---- the database-name trap ---------------------------------------- */

if (!dbName) {
  problems.push(
    'No database name in the URI. Mongoose will use a database called "test".\n' +
      '    Insert /webmachine between the host and the ?, like:\n' +
      `    mongodb+srv://user:pass@${host || 'cluster0.xxxxx.mongodb.net'}/webmachine?retryWrites=true`
  );
} else if (dbName !== 'webmachine') {
  warnings.push(`The database is "${dbName}", not "webmachine". Intentional?`);
}

/* ---- the password-encoding trap ------------------------------------ */

// These have meaning inside a URI, so a raw one splits the string in the
// wrong place. The failure surfaces as "authentication failed", which sends
// people off checking the password itself.
const RAW_SPECIALS = /[@/?#[\]]/;
if (password && RAW_SPECIALS.test(password)) {
  const found = [...new Set(password.match(/[@/?#[\]]/g))].join(' ');
  problems.push(
    `The password contains an unencoded URI character: ${found}\n` +
      '    Percent-encode it, or change the password to letters and digits:\n' +
      '    @ = %40    / = %2F    ? = %3F    # = %23    : = %3A    [ = %5B    ] = %5D'
  );
}

if (password && /%[0-9a-fA-F]{2}/.test(password)) {
  warnings.push('The password looks percent-encoded already. Make sure it is not double-encoded.');
}

if (!username || !password) {
  if (scheme === 'mongodb+srv') {
    problems.push('Atlas requires a username and password in the URI.');
  }
}

if (scheme === 'mongodb+srv' && !/retryWrites=true/.test(query)) {
  warnings.push('retryWrites=true is missing. Atlas recommends it.');
}

/* ────────────────────────────────────────────────────────────
   2. REPORT STATIC PROBLEMS
   ──────────────────────────────────────────────────────────── */

for (const w of warnings) console.log(`  warn   ${w}`);
if (warnings.length) console.log('');

if (problems.length) {
  for (const p of problems) console.error(`  FAIL   ${p}`);
  console.error('\nFix the URI, then run this again.\n');
  process.exit(1);
}

console.log('  The URI parses and looks complete. Dialling...\n');

/* ────────────────────────────────────────────────────────────
   3. LIVE CONNECTION
   ──────────────────────────────────────────────────────────── */

/** Maps a driver error to the thing you actually have to go and change. */
function explain(err) {
  const m = String(err.message || '');

  if (/Authentication failed|bad auth/i.test(m)) {
    return [
      'Authentication failed.',
      '  The username or password is wrong, OR the password contains a',
      '  character that needs percent-encoding. Atlas: Database Access →',
      '  Edit user → Edit Password. An alphanumeric password avoids this',
      '  entirely.',
    ];
  }

  if (/ENOTFOUND|querySrv/i.test(m)) {
    return [
      'The cluster hostname does not resolve.',
      '  The host in the URI is mistyped. Copy it again from Atlas:',
      '  Connect → Drivers → Node.js.',
    ];
  }

  if (/timed out|ETIMEDOUT|ServerSelection/i.test(m)) {
    return [
      'Could not reach the cluster.',
      '  Almost always the IP allowlist. Atlas → Network Access → Add IP',
      '  Address → Allow access from anywhere (0.0.0.0/0). Railway has no',
      '  static outbound IP on the hobby plan, so there is nothing narrower',
      '  to allowlist.',
      '  Also check the cluster is not paused.',
    ];
  }

  if (/ECONNREFUSED/i.test(m)) {
    return [
      'Connection refused.',
      '  Nothing is listening at that address. If this is a local mongod,',
      '  start it. If it is Atlas, re-copy the connection string.',
    ];
  }

  return [m];
}

(async () => {
  const started = Date.now();

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000, maxPoolSize: 2 });

    const connectMs = Date.now() - started;

    const pingStart = Date.now();
    await mongoose.connection.db.admin().command({ ping: 1 });
    const pingMs = Date.now() - pingStart;

    const collections = await mongoose.connection.db.listCollections().toArray();
    let stats = null;
    try {
      stats = await mongoose.connection.db.stats();
    } catch {
      /* M0 restricts dbStats on some clusters; not fatal */
    }

    console.log('  CONNECTED\n');
    line('database', mongoose.connection.name);
    line('connect', `${connectMs} ms`);
    line('ping', `${pingMs} ms`);
    line('collections', collections.length ? collections.map((c) => c.name).join(', ') : '(none yet)');
    if (stats) {
      line('storage used', `${(stats.storageSize / 1048576).toFixed(1)} MB`);
      line('documents', String(stats.objects));
    }

    if (pingMs > 250) {
      console.log(
        `\n  warn   ${pingMs} ms round trip is high. Put the Atlas cluster in the\n` +
          '         same region as the Railway service, or every request pays this.'
      );
    }

    if (!collections.length) {
      console.log(
        '\n  No collections yet, which is correct before the first run. They are\n' +
          '  created on the first write.'
      );
    }

    console.log('\n  Safe to paste this into Railway as MONGODB_URI.\n');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('  FAILED TO CONNECT\n');
    for (const l of explain(err)) console.error(`  ${l}`);
    console.error('');
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
