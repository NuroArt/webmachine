'use strict';

const config = require('../config');

/**
 * THE PRODUCT CATALOG — the single source of truth for pricing.
 *
 * The pre-checkout handler re-derives the expected Star cost from this file
 * and rejects any invoice whose amount does not match. That is what stops a
 * tampered invoice from underpaying, so nothing else in the codebase may
 * hardcode a price.
 */

/** A website: the pages a small business actually needs. */
const SITE_PAGES = [
  { key: 'index', filename: 'index.html', label: 'Home', navLabel: 'Home' },
  { key: 'about', filename: 'about.html', label: 'About', navLabel: 'About' },
  { key: 'services', filename: 'services.html', label: 'Services', navLabel: 'Services' },
  { key: 'pricing', filename: 'pricing.html', label: 'Pricing', navLabel: 'Pricing' },
  { key: 'contact', filename: 'contact.html', label: 'Contact', navLabel: 'Contact' },
];

/**
 * A funnel is a linear flow, not a site people browse. The pages are ordered
 * and each one has exactly one job, so there is no nav bar between them.
 */
const FUNNEL_PAGES = [
  { key: 'landing', filename: 'landing.html', label: 'Landing / opt-in' },
  { key: 'sales', filename: 'sales.html', label: 'Sales page' },
  { key: 'checkout', filename: 'checkout.html', label: 'Checkout' },
  { key: 'upsell', filename: 'upsell.html', label: 'Post-purchase upsell' },
  { key: 'thankyou', filename: 'thankyou.html', label: 'Thank-you / delivery' },
];

/** The free sample. One page, and it is a real page, not a watermarked shell. */
const PREVIEW_PAGES = [
  { key: 'index', filename: 'index.html', label: 'Home', navLabel: 'Home' },
];

const PRODUCTS = [
  {
    productId: 'preview',
    name: 'Free Homepage',
    tagline: 'One real page, no card, no catch.',
    description:
      'A complete, styled homepage built from your answers. Yours to keep and host anywhere. One per day.',
    starCost: 0,
    free: true,
    kind: 'site',
    pages: PREVIEW_PAGES,
    includes: [
      '1 finished page (index.html)',
      'Original copy written for your business',
      'Styling inlined, so the file works on its own',
      'Download as .zip or open a live preview',
    ],
  },
  {
    productId: 'site',
    name: 'Full Website',
    tagline: 'Five pages. Live in about a minute.',
    description:
      'Home, About, Services, Pricing and Contact. Real copy, consistent design, working nav between every page.',
    starCost: config.pricing.site,
    free: false,
    kind: 'site',
    pages: SITE_PAGES,
    includes: [
      '5 linked pages with working navigation',
      'Original copy written for your business',
      'One coherent design across the whole site',
      'Each page standalone: open any file, it still renders',
      '.zip download plus a live preview link',
    ],
  },
  {
    productId: 'funnel',
    name: 'Sales Funnel',
    tagline: 'Landing to thank-you, the whole flow.',
    description:
      'A five-page funnel: opt-in, sales page, checkout, post-purchase upsell and delivery page, written as one continuous pitch.',
    starCost: config.pricing.funnel,
    free: false,
    kind: 'funnel',
    pages: FUNNEL_PAGES,
    includes: [
      '5-page funnel in the proven order',
      'Direct-response copy carried across all five pages',
      'Checkout and upsell pages ready for your payment links',
      'Each page standalone: open any file, it still renders',
      '.zip download plus a live preview link',
    ],
  },
];

const PRODUCTS_BY_ID = Object.freeze(
  PRODUCTS.reduce((acc, p) => {
    acc[p.productId] = p;
    return acc;
  }, {})
);

/** Rough USD, for display only. Desktop Stars pay out near $0.013 each. */
function usdApprox(stars) {
  if (!stars) return 'Free';
  return `~$${Math.round(stars * 0.013)}`;
}

/** The shape the Mini App and the bot both render from. */
function toPublic(product) {
  return {
    productId: product.productId,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    starCost: product.starCost,
    usdApprox: usdApprox(product.starCost),
    pages: product.pages.map((p) => p.filename),
    pageCount: product.pages.length,
    includes: product.includes,
    free: Boolean(product.free),
  };
}

function publicCatalog() {
  return PRODUCTS.map(toPublic);
}

module.exports = {
  PRODUCTS,
  PRODUCTS_BY_ID,
  SITE_PAGES,
  FUNNEL_PAGES,
  PREVIEW_PAGES,
  publicCatalog,
  toPublic,
  usdApprox,
};
