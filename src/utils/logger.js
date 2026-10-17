'use strict';

const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-telegram-init-data"]',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'req.body.initData',
      '*.apiKey',
      '*.botToken',
    ],
    censor: '[redacted]',
  },
  transport: config.isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
});

module.exports = logger;
