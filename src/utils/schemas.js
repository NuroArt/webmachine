'use strict';

/**
 * RESPONSE ENVELOPE
 * -----------------
 * Every HTTP response from this service has the same shape, so the Mini App
 * has exactly one parsing path:
 *
 *   { ok: true,  type: "<route>", data: {...}, ts: <epoch ms> }
 *   { ok: false, error: { code, message, details }, ts: <epoch ms> }
 */

function ok(type, data) {
  return { ok: true, type, data, ts: Date.now() };
}

function fail(code, message, details = null) {
  return { ok: false, error: { code, message, details }, ts: Date.now() };
}

const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BAD_REQUEST',
  'UNKNOWN_PRODUCT',
  'FREE_BUILD_USED',
  'BUILD_IN_PROGRESS',
  'GENERATION_FAILED',
  'BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'CONFLICT',
  'INTERNAL_ERROR',
];

/**
 * JSON Schema definitions for every payload shape. Served at GET /schemas so
 * the front-end can validate against them, and asserted in scripts/e2eTest.js.
 */
const SCHEMAS = {
  Envelope: {
    type: 'object',
    required: ['ok', 'ts'],
    properties: {
      ok: { type: 'boolean' },
      type: { type: 'string' },
      data: { type: 'object' },
      error: { $ref: '#/definitions/ErrorObject' },
      ts: { type: 'integer' },
    },
  },

  ErrorObject: {
    type: 'object',
    required: ['code', 'message'],
    properties: {
      code: { type: 'string', enum: ERROR_CODES },
      message: { type: 'string' },
      details: { type: ['object', 'null'] },
    },
  },

  Owner: {
    type: 'object',
    required: ['userId', 'buildsTotal', 'freeBuildsLeft'],
    properties: {
      userId: { type: 'string' },
      username: { type: ['string', 'null'] },
      firstName: { type: ['string', 'null'] },
      buildsTotal: { type: 'integer', minimum: 0 },
      sitesBuilt: { type: 'integer', minimum: 0 },
      funnelsBuilt: { type: 'integer', minimum: 0 },
      freeBuildsLeft: { type: 'integer', minimum: 0 },
      starsSpent: { type: 'integer', minimum: 0 },
      referralCode: { type: ['string', 'null'] },
      referrals: { type: 'integer', minimum: 0 },
    },
  },

  BuildObject: {
    type: 'object',
    required: ['id', 'productId', 'name', 'status', 'pageCount'],
    properties: {
      id: { type: 'string' },
      productId: { type: 'string' },
      name: { type: 'string' },
      businessName: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['generating', 'ready', 'failed', 'refunded'] },
      pageCount: { type: 'integer', minimum: 0 },
      pages: { type: 'array', items: { type: 'string' } },
      previewUrl: { type: ['string', 'null'] },
      downloadUrl: { type: ['string', 'null'] },
      starsSpent: { type: 'integer', minimum: 0 },
      bytes: { type: 'integer', minimum: 0 },
      generationMs: { type: ['integer', 'null'] },
      error: { type: ['string', 'null'] },
      createdAt: { type: 'string' },
    },
  },

  ProductObject: {
    type: 'object',
    required: ['productId', 'name', 'starCost', 'pages'],
    properties: {
      productId: { type: 'string' },
      name: { type: 'string' },
      tagline: { type: 'string' },
      description: { type: 'string' },
      starCost: { type: 'integer', minimum: 0 },
      usdApprox: { type: 'string' },
      pages: { type: 'array', items: { type: 'string' } },
      pageCount: { type: 'integer' },
      includes: { type: 'array', items: { type: 'string' } },
      free: { type: 'boolean' },
    },
  },

  /** GET /api/state */
  StateResponse: {
    type: 'object',
    required: ['owner', 'builds', 'catalog'],
    properties: {
      owner: { $ref: '#/definitions/Owner' },
      builds: { type: 'array', items: { $ref: '#/definitions/BuildObject' } },
      catalog: { type: 'array', items: { $ref: '#/definitions/ProductObject' } },
      activeBuild: { type: ['object', 'null'] },
      created: { type: 'boolean' },
    },
  },

  /** POST /api/invoice */
  InvoiceResponse: {
    type: 'object',
    required: ['mode', 'invoiceLink', 'productId', 'starCost'],
    properties: {
      mode: { const: 'invoice' },
      invoiceLink: { type: 'string' },
      productId: { type: 'string' },
      starCost: { type: 'integer' },
      transactionId: { type: 'string' },
    },
  },

  /** POST /api/build (free tier) and the payment-driven build result */
  BuildResponse: {
    type: 'object',
    required: ['ok', 'build'],
    properties: {
      ok: { type: 'boolean' },
      build: { $ref: '#/definitions/BuildObject' },
      refunded: { type: 'boolean' },
      starsReturned: { type: 'integer' },
      owner: { $ref: '#/definitions/Owner' },
    },
  },
};

module.exports = { ok, fail, SCHEMAS, ERROR_CODES };
