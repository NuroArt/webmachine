#!/usr/bin/env node
'use strict';

/**
 * Generates one build straight to disk, with no Telegram, no Discord and no
 * database.
 *
 * The point is to see what the generator actually produces after a change to
 * the prompts or the stylesheet, without deploying and without competing with
 * the live bot for the same token. It costs one real API call.
 *
 *   node scripts/tryBuild.js                      # free homepage
 *   node scripts/tryBuild.js site                 # the paid 5-page site
 *   node scripts/tryBuild.js funnel "Acme Co" "what they sell" "who buys"
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const gen = require('../src/claude/siteGenerator');
const catalog = require('../src/catalog/products');

const [, , idArg, business, offer, audience, style] = process.argv;

const id = idArg && catalog.PRODUCTS_BY_ID[idArg] ? idArg : 'preview';
const product = catalog.PRODUCTS_BY_ID[id];

const inputs = {
  business: business || 'Harbour Lane Bakery',
  offer: offer || 'Sourdough, pastries and custom celebration cakes, baked daily',
  audience: audience || 'Local families and nearby offices ordering for meetings',
  style: style || '',
};

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Check .env.');
    process.exit(1);
  }

  console.log(`product: ${id} (${product.pages.length} page(s))`);
  console.log(`business: ${inputs.business}\n`);

  const res = await gen.generateBuild(product, inputs, {
    onProgress: ({ stage, label }) => console.log(`  ${stage.padEnd(9)} ${label || ''}`),
  });

  if (!res.ok) {
    console.error(`\nFAILED: ${res.error}`);
    for (const n of res.notes) console.error(`  ${n}`);
    process.exit(1);
  }

  const out = path.join(process.cwd(), 'out', String(Date.now()));
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(res.files)) {
    fs.writeFileSync(path.join(out, name), body);
  }

  console.log(`\nwrote ${Object.keys(res.files).length} files to ${out}`);
  console.log(`model ${res.model}, ${Math.round(res.ms / 1000)}s, ${res.bytes} bytes`);

  // The notes are where truncation and repairs are reported. They are the
  // reason to run this at all, so they are not buried behind a flag.
  if (res.notes.length) {
    console.log('\nnotes:');
    for (const n of res.notes) console.log(`  ${n}`);
  }

  // A quick read on the exact failure this script was written to catch.
  const css = res.files['style.css'] || '';
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  console.log('\ncheck:');
  console.log(`  stylesheet ${css.length} bytes, braces ${opens}/${closes}${opens === closes ? '' : '  ← UNBALANCED'}`);
  for (const cls of ['wm-form', 'wm-input', 'wm-cta-band', 'wm-footer', 'wm-step']) {
    const n = (css.match(new RegExp(`\\.${cls}[^-a-z]`, 'g')) || []).length;
    console.log(`  .${cls.padEnd(12)} ${n} rule(s)${n === 0 ? '  ← MISSING' : ''}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
