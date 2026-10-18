'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');
const mongoose = require('mongoose');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { globalLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { ok, SCHEMAS } = require('./utils/schemas');
const { publicCatalog } = require('./catalog/products');
const { spendToday, budgetExceeded } = require('./claude/client');

const apiRoutes = require('./routes/api');
const webhookRoutes = require('./routes/webhook');

function createApp() {
  const app = express();

  // Behind a load balancer (Railway, Render, Fly, nginx) so rate limiting and
  // req.ip read the forwarded address rather than the proxy's.
  app.set('trust proxy', 1);

  /**
   * Helmet's default CSP is `default-src 'self'`, which would block the
   * Telegram Mini App SDK, Google Fonts and the page's own inline script.
   * The policy below opens exactly those and nothing else: no eval, no
   * arbitrary script hosts, and `frame-ancestors` still permits only Telegram
   * to embed the app.
   *
   * Generated previews are served under /p/ and strip this header, because
   * they are the buyer's own pages and load their own fonts and images.
   */
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://telegram.org'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    })
  );

  app.use(compression());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
    })
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Allow server-to-server calls (no Origin) and Telegram's own clients.
        if (!origin) return cb(null, true);
        if (config.corsOrigins.length === 0) return cb(null, true);
        if (config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Dev-User-Id'],
    })
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  // ---- Health & meta ----------------------------------------------------
  app.get('/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      db: states[mongoose.connection.readyState] || 'unknown',
      env: config.env,
      version: require('../package.json').version,
      spendToday: Number(spendToday().toFixed(4)),
      paused: budgetExceeded(),
      // The bot id is public (it is in every t.me link). It is here so a
      // Mini App auth failure can be diagnosed from outside the box: if this
      // does not match the bot you opened, the service holds another bot's
      // token and no amount of initData debugging will help.
      botId: config.telegram.botId,
      miniAppUrl: config.telegram.miniAppUrl || null,
    });
  });

  app.get('/schemas', (req, res) => res.json(ok('schemas', { definitions: SCHEMAS })));
  app.get('/pricing.json', (req, res) => res.json(ok('catalog', { catalog: publicCatalog() })));

  // ---- Webhook (no global limiter: Telegram must never be throttled) -----
  app.use('/webhook', webhookRoutes);

  // ---- Previews and downloads (capability URLs, before the API) ----------
  app.use('/', apiRoutes.publicRouter);

  // ---- Mini App API ------------------------------------------------------
  app.use('/api', globalLimiter, apiRoutes);

  // ---- Mini App front-end ------------------------------------------------
  // Served from the same origin as the API, so the browser needs no CORS
  // preflight and the client can use relative URLs. Mounted after the API
  // routes so a static file can never shadow an endpoint.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      maxAge: config.isProd ? '1h' : 0,
      etag: true,
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
