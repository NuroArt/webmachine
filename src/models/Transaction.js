'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const { PLATFORMS, DEFAULT_PLATFORM } = require('../utils/identity');

/**
 * Every Stars movement is recorded here. `telegramChargeId` is unique, which
 * is what makes the payment webhook idempotent: a replayed Telegram delivery
 * hits the unique index and is discarded instead of building twice.
 */
const TransactionSchema = new Schema(
  {
    /** Composite "<platform>:<rawId>" — see utils/identity.js. */
    userId: { type: String, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, default: DEFAULT_PLATFORM, index: true },

    kind: {
      type: String,
      enum: ['stars_purchase', 'refund'],
      required: true,
    },

    /** Stars amount. Always positive; `kind` carries the direction. */
    stars: { type: Number, required: true, min: 0 },

    productId: { type: String, required: true },

    /** Opaque payload we put on the invoice and read back on payment. */
    invoicePayload: { type: String, index: true },

    /**
     * The intake answers, captured when the invoice was created.
     *
     * They have to live here rather than in memory: the buyer may pay minutes
     * later, from another device, and the webhook that fulfils the payment is
     * a different request with no session to read from.
     */
    inputs: { type: Schema.Types.Mixed, default: null },

    telegramChargeId: { type: String, index: true, unique: true, sparse: true },
    providerPaymentChargeId: { type: String, default: null },

    status: {
      type: String,
      enum: ['pending', 'paid', 'fulfilled', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },

    siteId: { type: Schema.Types.ObjectId, ref: 'Site', default: null },

    error: { type: String, default: null },
    rawUpdate: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', TransactionSchema);
