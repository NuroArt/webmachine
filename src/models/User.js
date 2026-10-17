'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * A WebMachine owner. No game economy: this tracks identity, entitlement to
 * the daily free build, lifetime counters and referrals.
 */
const UserSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    languageCode: { type: String, default: null },
    isPremium: { type: Boolean, default: false },

    /** Lifetime counters. */
    buildsTotal: { type: Number, default: 0 },
    sitesBuilt: { type: Number, default: 0 },
    funnelsBuilt: { type: Number, default: 0 },
    freeBuildsUsed: { type: Number, default: 0 },
    starsSpent: { type: Number, default: 0 },

    /** Free-build window. Reset lazily on read, never by a cron. */
    freeBuildsUsedToday: { type: Number, default: 0 },
    freeWindowStartedAt: { type: Date, default: () => new Date() },

    /**
     * Set while a generation is in flight so two concurrent requests cannot
     * both start a build and bill twice.
     */
    activeBuildId: { type: Schema.Types.ObjectId, ref: 'Site', default: null },
    activeBuildStartedAt: { type: Date, default: null },

    /**
     * In-progress bot intake.
     *
     * Kept on the user document rather than in process memory so a redeploy
     * mid-conversation does not drop someone three questions in, and so the
     * webhook stays stateless.
     */
    intake: { type: Schema.Types.Mixed, default: null },

    /** Referrals. */
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: String, default: null },
    referrals: { type: Number, default: 0 },

    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

UserSchema.methods.toPublic = function toPublic(freeBuildsLeft) {
  return {
    userId: this.userId,
    username: this.username,
    firstName: this.firstName,
    buildsTotal: this.buildsTotal,
    sitesBuilt: this.sitesBuilt,
    funnelsBuilt: this.funnelsBuilt,
    freeBuildsLeft: Number(freeBuildsLeft ?? 0),
    starsSpent: this.starsSpent,
    referralCode: this.referralCode || null,
    referrals: this.referrals,
  };
};

module.exports = mongoose.model('User', UserSchema);
