'use strict';

class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expected = true;
  }
}

const Errors = {
  unauthorized: (msg = 'Invalid or missing Telegram authentication') =>
    new AppError('UNAUTHORIZED', msg, 401),
  notFound: (msg = 'Resource not found') => new AppError('NOT_FOUND', msg, 404),
  badRequest: (msg, details) => new AppError('BAD_REQUEST', msg, 400, details),
  forbidden: (msg = 'Not yours') => new AppError('FORBIDDEN', msg, 403),

  unknownProduct: (productId) =>
    new AppError('UNKNOWN_PRODUCT', 'That product does not exist.', 400, { productId }),
  freeBuildUsed: (resetsInSeconds) =>
    new AppError('FREE_BUILD_USED', 'You have used your free build for today.', 400, { resetsInSeconds }),
  buildInProgress: () =>
    new AppError('BUILD_IN_PROGRESS', 'A build is already running. Wait for it to finish.', 409),
  generationFailed: (msg = 'The build could not be generated.') =>
    new AppError('GENERATION_FAILED', msg, 502),
  budgetExceeded: () =>
    new AppError('BUDGET_EXCEEDED', 'Builds are paused right now. Try again in a few hours.', 503),

  rateLimited: (msg = 'Slow down.') => new AppError('RATE_LIMITED', msg, 429),
  upstream: (msg = 'Upstream service failed') => new AppError('UPSTREAM_ERROR', msg, 502),
  conflict: (msg) => new AppError('CONFLICT', msg, 409),
};

module.exports = { AppError, Errors };
