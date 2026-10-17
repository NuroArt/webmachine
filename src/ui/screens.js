'use strict';

/**
 * THE ERROR UI CONTRACT
 *
 * The Mini App renders its own screens from the data envelope, so this module
 * is deliberately small. What it does own is error presentation, because that
 * policy belongs on the server: whether a failure is a toast the user can
 * dismiss or a takeover screen they must act on can then change without
 * shipping a new client.
 */

const CONTRACT_VERSION = 1;

const SCREENS = ['main', 'builds', 'build', 'store', 'intake', 'error'];

/**
 * Errors that are worth interrupting for. Everything else is a toast: the
 * user's work is intact and they can carry on.
 */
const TAKEOVER_CODES = new Set([
  'UNAUTHORIZED',
  'INTERNAL_ERROR',
  'BUDGET_EXCEEDED',
  'UPSTREAM_ERROR',
]);

/** How each error reads to a person, and what they can do next. */
const COPY = {
  UNAUTHORIZED: {
    title: 'Session expired',
    body: 'Close the app and reopen it from the bot.',
    action: null,
  },
  FORBIDDEN: { title: 'Not yours', body: 'That build belongs to another account.', action: 'back' },
  NOT_FOUND: { title: 'Gone', body: 'That build no longer exists.', action: 'back' },
  FREE_BUILD_USED: {
    title: 'Free build used',
    body: 'Your free build resets tomorrow. The full site is ready now.',
    action: 'store',
  },
  BUILD_IN_PROGRESS: {
    title: 'Already building',
    body: 'One build at a time. This one is nearly done.',
    action: 'refresh',
  },
  GENERATION_FAILED: {
    title: 'Build failed',
    body: 'Nothing was charged, or you have been refunded. Try again.',
    action: 'retry',
  },
  BUDGET_EXCEEDED: {
    title: 'Builds paused',
    body: 'Capacity is maxed out for today. Try again in a few hours.',
    action: null,
  },
  RATE_LIMITED: { title: 'Slow down', body: 'Give it a moment and try again.', action: 'retry' },
  UPSTREAM_ERROR: {
    title: 'Upstream hiccup',
    body: 'Something outside this app failed. Try again shortly.',
    action: 'retry',
  },
  UNKNOWN_PRODUCT: { title: 'Gone', body: 'That product is no longer offered.', action: 'store' },
  CONFLICT: { title: 'Conflict', body: 'That already exists.', action: 'refresh' },
  BAD_REQUEST: { title: 'Check that again', body: null, action: 'back' },
  INTERNAL_ERROR: {
    title: 'Something went wrong',
    body: 'This one is on us. Try again, and it is logged either way.',
    action: 'retry',
  },
};

/**
 * @param {{code:string,message:string,details:object|null}} err
 * @param {{backScreen?:string}} opts
 */
function renderError(err, opts = {}) {
  const code = err?.code || 'INTERNAL_ERROR';
  const copy = COPY[code] || COPY.INTERNAL_ERROR;
  const inline = !TAKEOVER_CODES.has(code);

  return {
    screen: 'error',
    version: CONTRACT_VERSION,
    ts: Date.now(),
    error: {
      code,
      inline,
      title: copy.title,
      // The server's message is usually the more specific one.
      body: err?.message || copy.body || 'Try again.',
      action: copy.action,
      backScreen: SCREENS.includes(opts.backScreen) ? opts.backScreen : 'main',
      details: err?.details || null,
    },
  };
}

module.exports = { CONTRACT_VERSION, SCREENS, TAKEOVER_CODES, COPY, renderError };
