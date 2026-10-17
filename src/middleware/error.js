'use strict';

const logger = require('../utils/logger');
const config = require('../config');
const { fail } = require('../utils/schemas');
const { renderError } = require('../ui/screens');

/**
 * Attaches a UI envelope to an error response.
 *
 * No database read happens here on purpose: error paths must stay cheap, and a
 * failing request is exactly when the database is most likely to be the thing
 * that is unhappy. The envelope therefore carries no `owner` - the client keeps
 * the one it already has and only repaints the error.
 *
 * `error.inline` tells the client whether this is a toast ("free build used")
 * or a full takeover screen ("session expired"). That policy lives server-side
 * so it can change without a client release.
 */
function withUi(body, req) {
  const mode = (req.query?.ui || req.body?.ui || '').toString().toLowerCase();
  if (mode === 'none') return body;

  const backScreen = (req.query?.screen || req.body?.screen || 'main').toString();
  try {
    return { ...body, ui: renderError(body.error, { backScreen }) };
  } catch {
    return body;
  }
}

function notFoundHandler(req, res) {
  res.status(404).json(fail('NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Expected, user-facing errors carry their own code and status.
  if (err && err.expected) {
    logger.debug({ code: err.code, path: req.path }, err.message);
    return res
      .status(err.status || 400)
      .json(withUi(fail(err.code, err.message, err.details || null), req));
  }

  if (err && err.name === 'ValidationError') {
    return res.status(400).json(withUi(fail('BAD_REQUEST', 'Validation failed', err.errors), req));
  }

  if (err && err.code === 11000) {
    return res.status(409).json(withUi(fail('CONFLICT', 'That record already exists'), req));
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json(withUi(fail('BAD_REQUEST', 'Request body is not valid JSON'), req));
  }

  logger.error({ err: err?.message, stack: err?.stack, path: req.path }, 'Unhandled error');

  return res.status(500).json(
    withUi(
      fail('INTERNAL_ERROR', config.isProd ? 'Something went wrong.' : err?.message || 'Unknown error'),
      req
    )
  );
}

module.exports = { notFoundHandler, errorHandler };
