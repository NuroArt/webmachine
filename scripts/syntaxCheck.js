#!/usr/bin/env node
'use strict';

/**
 * Loads every source file to prove it parses and its requires resolve.
 * Run with: npm run check
 *
 * This is the cheapest test in the suite and it catches the whole class of
 * damage that hand-editing a file causes: a duplicate declaration, an unclosed
 * block, a require that points at a file that was renamed.
 */

const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/webmachine-check';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:CHECK-TOKEN';

const ROOT = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * src/index.js boots the server and dials MongoDB on require, so it is parsed
 * rather than loaded. Everything else is safe to require, and requiring is the
 * stronger check because it resolves the dependency graph too.
 */
const SIDE_EFFECTS = new Set(['src/index.js']);

const files = walk(ROOT).sort();
let failed = 0;

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
  try {
    if (SIDE_EFFECTS.has(rel)) {
      new (require('vm').Script)(fs.readFileSync(file, 'utf8'), { filename: file });
      console.log(`  parsed ${rel}`);
    } else {
      require(file);
      console.log(`  ok     ${rel}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`  FAIL   ${rel}\n         ${err.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} modules loaded.`);

if (failed) {
  console.error('\nSyntax check failed.');
  process.exit(1);
}
console.log('Syntax check passed.');
