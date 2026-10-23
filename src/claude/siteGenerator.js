'use strict';

const {
  complete,
  extractJson,
  extractHtml,
  extractCss,
  budgetExceeded,
} = require('./client');
const P = require('./sitePrompts');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * THE GENERATOR
 *
 * One contract governs this whole module: it never throws for a content
 * reason. Every failure path returns `{ ok: false, error }` so the caller can
 * decide whether to refund Stars.
 *
 * A build that fails after a successful payment must never lose the buyer's
 * money, and a thrown exception halfway through fulfilment is exactly how that
 * happens.
 */

const DASH = /\s*[—–]\s*/g;
const PLACEHOLDER = /\[(?:business[ _]?name|your[^\]]{0,30}|insert[^\]]{0,30}|product|company)\]|\{\{[^}]{1,40}\}\}|lorem ipsum/gi;

/* ────────────────────────────────────────────────────────────
   DETERMINISTIC REPAIR
   Never ask a model to honour a character-level rule a regex
   enforces perfectly.
   ──────────────────────────────────────────────────────────── */

function scrubDashes(s) {
  return String(s).replace(DASH, '. ').replace(/\.\s*\.(?!\.)/g, '.');
}

/** Returns the unique wm- class names that really appear in the markup. */
function collectClassNames(htmlParts) {
  const found = new Set();
  const attr = /class\s*=\s*"([^"]*)"/gi;

  for (const html of htmlParts) {
    if (!html) continue;
    let m;
    while ((m = attr.exec(html)) !== null) {
      for (const token of m[1].split(/\s+/)) {
        if (token) found.add(token);
      }
    }
  }

  return [...found].sort();
}

/**
 * A crude balance check. It cannot validate HTML, but it reliably catches the
 * one failure that matters here: a response cut off at max_tokens, which
 * leaves tags open and renders as a broken page.
 */
function looksUnbalanced(html) {
  const voids = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const stack = [];
  let m;

  while ((m = tag.exec(html)) !== null) {
    const [, closing, rawName, selfClosed] = m;
    const name = rawName.toLowerCase();
    if (voids.has(name) || selfClosed === '/') continue;
    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) return true;
      stack.length = idx;
    } else {
      stack.push(name);
    }
  }

  return stack.length > 0;
}

function googleFontsLink(typography = {}) {
  const fams = [typography.headingFont, typography.bodyFont]
    .filter(Boolean)
    .map((f) => String(f).trim())
    .filter((f, i, a) => a.indexOf(f) === i);

  if (!fams.length) return '';

  const q = fams
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`)
    .join('&');

  return [
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&display=swap">`,
  ].join('\n');
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Wraps one page's body markup into a complete, standalone document with the
 * stylesheet inlined.
 *
 * The CSS is inlined on purpose rather than linked to a shared style.css. A
 * non-technical buyer who opens a single .html straight out of the download,
 * without extracting the whole folder, still sees a styled page. That one
 * decision removes an entire class of support request.
 */
function assemblePage({ page, body, css, brief, product }) {
  const title =
    page.key === 'index' || page.key === 'landing'
      ? `${brief.businessName} | ${brief.tagline}`
      : `${page.label} | ${brief.businessName}`;

  const desc = String(brief.positioning || brief.tagline || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 155);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
${googleFontsLink(brief.typography)}
  <style>
${css}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

/* ────────────────────────────────────────────────────────────
   STAGE 1 — BRIEF
   ──────────────────────────────────────────────────────────── */

const FALLBACK_PALETTE = {
  bg: '#ffffff',
  surface: '#f5f7fa',
  ink: '#14171c',
  muted: '#5b6472',
  accent: '#1b64f2',
  accentInk: '#ffffff',
  border: '#e2e6eb',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Fills in anything the brief is missing. The page and CSS stages both read
 * from the brief, so a half-formed one must not be allowed downstream.
 */
function normalizeBrief(raw, inputs, product) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const palette = { ...FALLBACK_PALETTE, ...(b.palette || {}) };

  for (const [k, v] of Object.entries(palette)) {
    if (!HEX.test(String(v))) palette[k] = FALLBACK_PALETTE[k];
  }

  const sections = b.sections && typeof b.sections === 'object' ? b.sections : {};
  for (const page of product.pages) {
    if (!Array.isArray(sections[page.key]) || !sections[page.key].length) {
      sections[page.key] = [];
    }
  }

  return {
    businessName: scrubDashes(b.businessName || P.clean(inputs.business) || 'The Business'),
    tagline: scrubDashes(b.tagline || ''),
    positioning: scrubDashes(b.positioning || ''),
    voice: scrubDashes(b.voice || 'clear, confident, practical'),
    palette,
    typography: {
      headingFont: b.typography?.headingFont || 'Inter',
      bodyFont: b.typography?.bodyFont || 'Inter',
      mood: b.typography?.mood || 'clean and modern',
    },
    sections,
    cta: {
      primary: scrubDashes(b.cta?.primary || 'Get started'),
      secondary: scrubDashes(b.cta?.secondary || 'See how it works'),
    },
  };
}

async function generateBrief(inputs, product) {
  const res = await complete({
    system: P.BRIEF_SYSTEM,
    messages: [{ role: 'user', content: P.buildBriefPrompt(inputs, product) }],
    maxTokens: 2000,
    temperature: 0.8,
    prefill: '{',
    label: 'brief',
  });

  let parsed = extractJson(res.text);

  if (!parsed) {
    logger.warn({ snippet: res.text.slice(0, 300) }, 'Brief JSON parse failed; retrying strict');

    const retry = await complete({
      system: P.BRIEF_SYSTEM,
      messages: [
        { role: 'user', content: P.buildBriefPrompt(inputs, product) },
        { role: 'assistant', content: res.text.slice(0, 1200) },
        {
          role: 'user',
          content:
            'That was not valid JSON. Return ONLY the JSON object matching the schema. No fences, no commentary.',
        },
      ],
      maxTokens: 2000,
      temperature: 0.2,
      prefill: '{',
      label: 'brief-retry',
    });

    parsed = extractJson(retry.text);
  }

  // A missing brief is survivable: normalizeBrief fills every field.
  return normalizeBrief(parsed, inputs, product);
}

/* ────────────────────────────────────────────────────────────
   STAGE 2 — PAGES, IN PARALLEL
   ──────────────────────────────────────────────────────────── */

async function generatePage(page, brief, product) {
  const maxTokens = page.key === 'sales' ? 8000 : 5000;

  const res = await complete({
    system: P.PAGE_SYSTEM,
    messages: [{ role: 'user', content: P.buildPagePrompt(page, brief, product) }],
    maxTokens,
    temperature: 0.85,
    label: `page:${page.key}`,
  });

  let body = extractHtml(res.text);
  const notes = [];

  if (res.truncated) notes.push(`${page.filename}: hit the token limit and may be cut short`);
  if (body && looksUnbalanced(body)) notes.push(`${page.filename}: unclosed tags detected`);

  body = scrubDashes(body);

  const placeholders = body.match(PLACEHOLDER);
  if (placeholders) {
    notes.push(`${page.filename}: ${placeholders.length} placeholder token(s) left in the copy`);
  }

  return { page, body, notes, ms: res.ms, model: res.model, ok: Boolean(body && body.length > 200) };
}

/* ────────────────────────────────────────────────────────────
   STAGE 3 — CSS
   ──────────────────────────────────────────────────────────── */

async function generateCss(brief, classNames, product) {
  const res = await complete({
    system: P.CSS_SYSTEM,
    messages: [{ role: 'user', content: P.buildCssPrompt(brief, classNames, product) }],
    maxTokens: 8000,
    temperature: 0.4,
    label: 'css',
  });

  const css = extractCss(res.text);
  const notes = [];
  if (res.truncated) notes.push('style: hit the token limit and may be cut short');
  if (css && !css.includes(':root')) notes.push('style: no :root token block found');

  return { css, notes, ms: res.ms, ok: Boolean(css && css.length > 400) };
}

/* ────────────────────────────────────────────────────────────
   ORCHESTRATION
   ──────────────────────────────────────────────────────────── */

/**
 * Generates one complete build.
 *
 * @returns {Promise<{ok:boolean, files?:object, brief?:object, pageCount?:number,
 *                    bytes?:number, notes:string[], model?:string, ms:number, error?:string}>}
 */
async function generateBuild(product, inputs, opts = {}) {
  const started = Date.now();
  const notes = [];
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  if (budgetExceeded()) {
    return { ok: false, notes, ms: 0, error: 'Daily generation budget reached' };
  }

  try {
    // ---- 1. brief -------------------------------------------------------
    onProgress({ stage: 'brief', label: 'Planning the design and copy' });
    const brief = await generateBrief(inputs, product);

    // ---- 2. pages, all at once -----------------------------------------
    onProgress({
      stage: 'pages',
      label: `Writing ${product.pages.length} pages`,
      total: product.pages.length,
    });

    const results = await Promise.all(
      product.pages.map((page) =>
        generatePage(page, brief, product).catch((err) => ({
          page,
          body: '',
          notes: [`${page.filename}: ${err.message}`],
          ok: false,
          ms: 0,
        }))
      )
    );

    for (const r of results) notes.push(...r.notes);

    const good = results.filter((r) => r.ok);
    if (!good.length) {
      return {
        ok: false,
        notes,
        ms: Date.now() - started,
        error: 'No pages could be generated',
      };
    }
    if (good.length < results.length) {
      const failed = results.filter((r) => !r.ok).map((r) => r.page.filename);
      // A partial build is not shippable: the nav would link to missing files.
      return {
        ok: false,
        notes,
        ms: Date.now() - started,
        error: `These pages failed to generate: ${failed.join(', ')}`,
      };
    }

    // ---- 3. css, informed by the real markup ---------------------------
    onProgress({ stage: 'css', label: 'Designing the stylesheet' });

    const classNames = collectClassNames(good.map((r) => r.body));
    const cssResult = await generateCss(brief, classNames, product);
    notes.push(...cssResult.notes);

    if (!cssResult.ok) {
      return {
        ok: false,
        notes,
        ms: Date.now() - started,
        error: 'The stylesheet could not be generated',
      };
    }

    const css = scrubDashes(cssResult.css);

    // ---- 4. assemble ---------------------------------------------------
    onProgress({ stage: 'assemble', label: 'Assembling the files' });

    const files = {};
    let bytes = 0;

    for (const r of good) {
      const doc = assemblePage({ page: r.page, body: r.body, css, brief, product });
      files[r.page.filename] = doc;
      bytes += Buffer.byteLength(doc, 'utf8');
      notes.push(`${r.page.filename}: ${Buffer.byteLength(doc, 'utf8')} bytes`);
    }

    // Shipped alongside the pages for anyone who wants to edit the design in
    // one place. The pages themselves do not depend on it.
    files['style.css'] = css;

    files['README.txt'] = [
      `${brief.businessName}`,
      `${brief.tagline}`,
      '',
      'HOW TO USE THESE FILES',
      '',
      '1. Every .html file is standalone. Open any one of them and it renders',
      '   correctly, styled, with no setup.',
      product.kind === 'funnel'
        ? '2. The funnel runs in this order: landing, sales, checkout, upsell, thankyou.'
        : '2. Keep all the .html files in the same folder so the navigation links work.',
      '3. style.css is the same styling, extracted, in case you want to edit the',
      '   design in one place. Each page already has its own copy inlined.',
      '4. Search for "Replace" to find the form actions and payment links you',
      '   need to point at your own tools.',
      '',
      'To publish: upload the folder to any static host (Netlify, Cloudflare',
      'Pages, GitHub Pages, or your existing hosting).',
      '',
      `Generated ${new Date().toISOString().slice(0, 10)} by ${config.brandName}.`,
    ].join('\n');

    return {
      ok: true,
      files,
      brief,
      pageCount: good.length,
      bytes,
      notes,
      model: good[0]?.model || null,
      ms: Date.now() - started,
    };
  } catch (err) {
    logger.error({ err: err.message, productId: product.productId }, 'Build generation threw');
    return {
      ok: false,
      notes,
      ms: Date.now() - started,
      error: err.message || 'Build generation failed',
    };
  }
}

module.exports = {
  generateBuild,
  generateBrief,
  generatePage,
  generateCss,
  // exported for the self-test
  collectClassNames,
  looksUnbalanced,
  scrubDashes,
  normalizeBrief,
  assemblePage,
};
