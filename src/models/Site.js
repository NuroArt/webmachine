'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * The capability slug. Unguessable, and it lives in the URL path rather than a
 * query string so the generated pages' relative links ("about.html") keep
 * working as the visitor clicks through the preview.
 */
function newSlug() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * One generated build: a website or a funnel.
 *
 * `files` is a map of filename to full file contents. Every page carries its
 * own CSS inlined in its <head>, so a single .html opened on its own still
 * renders correctly. That is deliberate: the previous version shipped a shared
 * style.css inside a zip, and non-technical buyers opened the html without
 * extracting it and saw an unstyled page.
 */
const SiteSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },

    slug: { type: String, required: true, unique: true, index: true, default: newSlug },

    name: { type: String, required: true },
    businessName: { type: String, default: null },

    /** The intake answers this build was generated from. */
    inputs: { type: Schema.Types.Mixed, default: {} },

    /**
     * The generated files, in page order.
     *
     * An array of subdocuments rather than a Map: MongoDB forbids a dot in a
     * map key, and every filename here has one ("index.html"). Ordering is
     * useful anyway, since a funnel's pages are a sequence.
     */
    files: {
      type: [
        {
          _id: false,
          filename: { type: String, required: true },
          content: { type: String, required: true },
        },
      ],
      default: () => [],
    },
    pageCount: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },

    source: { type: String, enum: ['stars', 'free', 'admin'], default: 'stars' },
    starsSpent: { type: Number, default: 0 },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },

    generationModel: { type: String, default: null },
    generationMs: { type: Number, default: null },
    /** Per-page notes: truncation warnings, retries, byte sizes. */
    generationNotes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['generating', 'ready', 'failed', 'refunded'],
      default: 'generating',
      index: true,
    },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

SiteSchema.index({ userId: 1, createdAt: -1 });

/* ---- file accessors ------------------------------------------------- */

SiteSchema.methods.fileNames = function fileNames() {
  return this.files.map((f) => f.filename);
};

SiteSchema.methods.hasFile = function hasFile(filename) {
  return this.files.some((f) => f.filename === filename);
};

SiteSchema.methods.getFile = function getFile(filename) {
  const hit = this.files.find((f) => f.filename === filename);
  return hit ? hit.content : undefined;
};

SiteSchema.methods.fileEntries = function fileEntries() {
  return this.files.map((f) => [f.filename, f.content]);
};

/** The page a preview link should open on. */
SiteSchema.methods.entryFile = function entryFile() {
  if (this.hasFile('index.html')) return 'index.html';
  if (this.hasFile('landing.html')) return 'landing.html';
  const html = this.fileNames().filter((n) => n.endsWith('.html'));
  return html[0] || this.fileNames()[0] || 'index.html';
};

SiteSchema.statics.toFileArray = function toFileArray(filesObject) {
  return Object.entries(filesObject || {}).map(([filename, content]) => ({ filename, content }));
};

/** Metadata only. Never ships the file bodies, which can be hundreds of KB. */
SiteSchema.methods.toPublic = function toPublic(urls = {}) {
  return {
    id: this._id.toString(),
    productId: this.productId,
    name: this.name,
    businessName: this.businessName,
    status: this.status,
    pageCount: this.pageCount,
    pages: this.fileNames(),
    previewUrl: urls.previewUrl || null,
    downloadUrl: urls.downloadUrl || null,
    starsSpent: this.starsSpent,
    bytes: this.bytes,
    generationMs: this.generationMs,
    error: this.error,
    createdAt: this.createdAt ? this.createdAt.toISOString() : new Date().toISOString(),
  };
};

module.exports = mongoose.model('Site', SiteSchema);
module.exports.newSlug = newSlug;
