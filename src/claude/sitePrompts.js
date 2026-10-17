'use strict';

/**
 * THE PROMPT LAYER — this is the product.
 *
 * Generation runs in three stages, and the order is deliberate:
 *
 *   1. BRIEF  (JSON)  one call. Fixes the business positioning, palette, type
 *                     and per-page section plan up front.
 *   2. PAGES  (HTML)  one call per page, all in parallel, each handed the same
 *                     brief. Parallel is safe because the brief already
 *                     guarantees consistency between them.
 *   3. CSS    (one)   runs last, informed by the class names that actually
 *                     appear in the generated markup.
 *
 * Stage 3 must stay after stage 2. Generating the stylesheet first produces
 * selectors for markup that was never written, which is how the previous
 * version shipped unstyled pages.
 */

const BASE_SYSTEM = `You are a senior web designer and direct-response copywriter. You build small business websites and sales funnels that look professionally designed and read like a sharp human wrote them.

You write production markup: semantic HTML, real copy, no lorem ipsum, no placeholder brackets.

## ABSOLUTE RULES

- Never write the characters — or –. Use a period, a comma, or a colon. This is checked by a program.
- Never output placeholder tokens: no [Business Name], no {{product}}, no "Lorem ipsum", no "Your text here", no TODO. If you need a detail you were not given, invent a specific plausible one and commit to it.
- Never invent a statistic, a named customer, an award or a review and present it as verified fact. Testimonials must read as illustrative, with first names and a role only.
- Never promise a specific financial result or make a medical, legal or financial claim that would require a licence.
- Write to one reader. Never "customers", "clients like you", "folks".
- Specificity beats adjectives. "Same-day callback, 7am to 7pm" beats "excellent customer service".`;

/* ────────────────────────────────────────────────────────────
   STAGE 1 — BRIEF
   ──────────────────────────────────────────────────────────── */

const BRIEF_SYSTEM = `${BASE_SYSTEM}

You are now in planning mode. You will return a single JSON object and nothing else: no prose, no code fences. Your entire response must parse with JSON.parse().`;

function buildBriefPrompt(inputs, product) {
  const pageList = product.pages
    .map((p) => `  - ${p.filename} (${p.label})`)
    .join('\n');

  const kind = product.kind === 'funnel' ? 'sales funnel' : 'business website';

  return `Plan a ${kind} from this intake.

<intake>
business: ${clean(inputs.business)}
what they sell: ${clean(inputs.offer)}
audience: ${clean(inputs.audience)}
style preference: ${clean(inputs.style) || 'not specified'}
</intake>

The ${kind} has exactly these pages:
${pageList}

Return this JSON object:

{
  "businessName": "the real or invented trading name, 1-4 words",
  "tagline": "under 12 words, specific, no buzzwords",
  "positioning": "two sentences on who this is for and why they pick it over the alternative",
  "voice": "three adjectives describing how the copy should sound",
  "palette": {
    "bg": "#hex page background",
    "surface": "#hex card/section background, close to bg",
    "ink": "#hex body text, high contrast on bg",
    "muted": "#hex secondary text",
    "accent": "#hex primary brand colour used for buttons and links",
    "accentInk": "#hex text colour that is readable ON accent",
    "border": "#hex hairline borders"
  },
  "typography": {
    "headingFont": "a Google Fonts family name",
    "bodyFont": "a Google Fonts family name",
    "mood": "one phrase describing the type feel"
  },
  "sections": {
${product.pages.map((p) => `    "${p.key}": ["3 to 6 section names for this page, in order"]`).join(',\n')}
  },
  "cta": {
    "primary": "the main action, 2-5 words, imperative",
    "secondary": "a lower-commitment action, 2-5 words"
  }
}

PALETTE RULES
- Pick a palette that fits this specific industry, not a generic blue.
- Body text on background must be clearly readable. Aim for a contrast ratio of at least 7:1.
- accentInk must be readable on accent: near-white on a dark accent, near-black on a light one.
- All seven colours are required and must be 6-digit hex.

Return only the JSON.`;
}

/* ────────────────────────────────────────────────────────────
   STAGE 2 — PAGES
   ──────────────────────────────────────────────────────────── */

/**
 * The class naming contract.
 *
 * The stylesheet is written in a separate call, so the two stages need a
 * shared vocabulary. Stage 3 also receives the class names that really
 * appeared in the markup, which covers anything invented beyond this list.
 */
const CLASS_CONTRACT = `CLASS NAMING CONTRACT

Every class you write starts with "wm-". Use these for structure, and invent further "wm-" classes freely for anything else:

  wm-nav  wm-nav-inner  wm-nav-brand  wm-nav-links  wm-nav-link  wm-nav-cta
  wm-hero  wm-hero-inner  wm-hero-title  wm-hero-sub  wm-hero-actions
  wm-section  wm-section-inner  wm-section-head  wm-section-title  wm-section-sub
  wm-grid  wm-grid-2  wm-grid-3  wm-card  wm-card-title  wm-card-body  wm-card-icon
  wm-list  wm-list-item
  wm-btn  wm-btn-primary  wm-btn-secondary
  wm-quote  wm-quote-text  wm-quote-author
  wm-price-grid  wm-price-card  wm-price-card-featured  wm-price-amount  wm-price-period  wm-price-features
  wm-form  wm-field  wm-label  wm-input  wm-textarea
  wm-faq  wm-faq-item  wm-faq-q  wm-faq-a
  wm-cta-band  wm-cta-band-inner
  wm-footer  wm-footer-inner  wm-footer-note
  wm-steps  wm-step  wm-step-num
  wm-media  wm-media-img

Never use inline style attributes. Never use a <style> tag. Never use Tailwind or Bootstrap class names. All styling comes from the separate stylesheet.`;

const IMAGE_RULE = `IMAGES

Use https://picsum.photos/seed/<unique-slug>/<width>/<height> for every image, with a different seed per image. Always include a real descriptive alt attribute. Wrap images in <div class="wm-media"> and give the img class="wm-media-img". Use at most 3 images per page.`;

function navHtml(product, currentKey) {
  if (product.kind === 'funnel') return '';
  const links = product.pages
    .map((p) => {
      const active = p.key === currentKey ? ' wm-nav-link-active' : '';
      return `        <a class="wm-nav-link${active}" href="${p.filename}">${p.navLabel || p.label}</a>`;
    })
    .join('\n');

  return `NAVIGATION

Start the page with exactly this nav block, unchanged except for BUSINESS_NAME:

<nav class="wm-nav">
  <div class="wm-nav-inner">
    <a class="wm-nav-brand" href="index.html">BUSINESS_NAME</a>
    <div class="wm-nav-links">
${links}
    </div>
  </div>
</nav>

Replace BUSINESS_NAME with the real business name. Do not change the hrefs: they are relative so the site works from a folder with no server.`;
}

/** What each funnel page is for. One job per page; do not blur them. */
const FUNNEL_BRIEFS = {
  landing:
    'The opt-in page. One promise, one form, nothing else. No nav, no footer links that lead away, no pricing. Hero with the promise, 3 bullets of what they get, an email capture form, and one line of reassurance under it. Short page.',
  sales:
    'The sales page. The long one. Problem, the cost of staying where they are, the mechanism that fixes it, what is included, pricing, objection handling, FAQ, and a closing CTA band. This page carries the argument.',
  checkout:
    'The checkout page. Calm and reassuring, never salesy. Order summary card, the form fields a payment processor needs, trust row (guarantee, secure payment, support), and a single submit button. Add a comment <!-- Replace form action with your payment link --> above the form.',
  upsell:
    'The post-purchase upsell. It opens by confirming the first purchase succeeded, then makes one additional offer that genuinely complements it. Two buttons: accept, and a plain-text decline link that is easy to find and not shamed.',
  thankyou:
    'The delivery page. Confirm the purchase, state exactly what happens next with timings, give access or next steps as numbered steps, and set expectations for support. Warm, brief, no selling.',
};

/** What each website page is for. */
const SITE_BRIEFS = {
  index:
    'The homepage. Hero with the tagline and primary CTA, a 3-card value section, a short how-it-works in steps, one testimonial, and a closing CTA band. It must stand alone as the strongest page.',
  about:
    'The about page. The real story: why this business exists, who runs it, what they believe about the work, and what that means for the reader. Concrete and human, never corporate.',
  services:
    'The services page. Each offering as a card with what it is, who it suits and what is included. Specific scope, no vague "solutions".',
  pricing:
    'The pricing page. Two or three tiers in a price grid with one marked featured, a clear list of what each includes, and an FAQ underneath answering the real buying questions.',
  contact:
    'The contact page. A short reassuring intro, a contact form, and the practical details: hours, response time, service area, and how to reach a human. Add a comment <!-- Replace form action with your form handler --> above the form.',
};

const PAGE_SYSTEM = `${BASE_SYSTEM}

You are now writing one page of markup. Return only HTML. No markdown fences, no explanation, no <!DOCTYPE>, no <html>, no <head>, no <body> tag. Start with the first visible element and end with the last.`;

function buildPagePrompt(page, brief, product) {
  const jobs = product.kind === 'funnel' ? FUNNEL_BRIEFS : SITE_BRIEFS;
  const job = jobs[page.key] || `The ${page.label} page.`;
  const sections = (brief.sections && brief.sections[page.key]) || [];
  const nav = navHtml(product, page.key);

  return `Write the ${page.label} page for this ${product.kind === 'funnel' ? 'funnel' : 'website'}.

<brief>
business: ${brief.businessName}
tagline: ${brief.tagline}
positioning: ${brief.positioning}
voice: ${brief.voice}
primary CTA: ${brief.cta?.primary || 'Get started'}
secondary CTA: ${brief.cta?.secondary || 'Learn more'}
</brief>

THIS PAGE'S JOB
${job}

${sections.length ? `SECTION PLAN (follow this order)\n${sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}
${nav ? `${nav}\n` : ''}
${CLASS_CONTRACT}

${IMAGE_RULE}

LENGTH
${page.key === 'sales' ? 'This is the long page. 900 to 1400 words of real copy.' : 'Substantial but not padded. 350 to 700 words of real copy.'}

Close the page with a <footer class="wm-footer"> containing the business name, the current year, and one short line. ${product.kind === 'funnel' ? 'The funnel footer has no links.' : ''}

Every tag you open must be closed. Return only the markup.`;
}

/* ────────────────────────────────────────────────────────────
   STAGE 3 — CSS
   ──────────────────────────────────────────────────────────── */

const CSS_SYSTEM = `${BASE_SYSTEM}

You are now writing one stylesheet for a site whose markup already exists. Return only CSS. No markdown fences, no <style> tag, no explanation.`;

function buildCssPrompt(brief, classNames, product) {
  const p = brief.palette || {};
  const t = brief.typography || {};

  return `Write the complete stylesheet for this ${product.kind === 'funnel' ? 'funnel' : 'website'}.

<design>
business: ${brief.businessName}
voice: ${brief.voice}
type mood: ${t.mood || 'clean and modern'}
heading font: ${t.headingFont || 'Inter'}
body font: ${t.bodyFont || 'Inter'}
</design>

TOKENS — define these on :root exactly as given and use them everywhere. Never hardcode a colour anywhere else.

:root {
  --bg: ${p.bg || '#ffffff'};
  --surface: ${p.surface || '#f6f7f9'};
  --ink: ${p.ink || '#15181d'};
  --muted: ${p.muted || '#5b6472'};
  --accent: ${p.accent || '#1b64f2'};
  --accent-ink: ${p.accentInk || '#ffffff'};
  --border: ${p.border || '#e3e6ea'};
}

THESE CLASSES APPEAR IN THE REAL MARKUP. Every one needs a rule, and nothing may be left unstyled:

${classNames.join(', ')}

REQUIREMENTS

- Mobile first. One breakpoint at 768px and one at 1024px. Grids collapse to a single column on phones.
- Content column maxes at 1120px, centred, with 20px side padding that never disappears on a narrow screen.
- Generous vertical rhythm: sections get 72px of padding on desktop, 48px on mobile.
- Headings use the heading font, body uses the body font. Set a type scale with clamp() so it breathes between phone and desktop.
- Buttons: wm-btn-primary is a solid accent fill with accent-ink text. wm-btn-secondary is a bordered transparent button. Both get a visible hover state and a focus-visible outline.
- Cards: surface background, hairline border, generous padding, subtle radius. No heavy drop shadows.
- The featured price card is visibly distinguished using the accent, not a different size that breaks the grid.
- Form inputs are full width with a clear focus state.
- The nav is sticky at the top with a background so content does not show through. wm-nav-link-active is visibly current. On phones the links wrap rather than overflow.
- Images: wm-media-img is width 100%, height auto, with a radius and no layout shift.
- Include @media (prefers-reduced-motion: reduce) and drop transitions inside it.
- Start with a short modern reset: box-sizing, margin zero, and -webkit-font-smoothing.
- Assume the font families are already loaded. Do not write an @import or a @font-face.

Return only the CSS.`;
}

/* ────────────────────────────────────────────────────────────
   helpers
   ──────────────────────────────────────────────────────────── */

/** Untrusted intake text: collapsed, trimmed and length-capped. */
function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

module.exports = {
  BASE_SYSTEM,
  BRIEF_SYSTEM,
  PAGE_SYSTEM,
  CSS_SYSTEM,
  buildBriefPrompt,
  buildPagePrompt,
  buildCssPrompt,
  CLASS_CONTRACT,
  FUNNEL_BRIEFS,
  SITE_BRIEFS,
  clean,
};
