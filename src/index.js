'use strict';

const config = require('./config');
const logger = require('./utils/logger');
const { connectDb, disconnectDb } = require('./db/connect');
const { createApp } = require('./app');
const { startDiscord, stopDiscord } = require('./discord/client');

async function main() {
  await connectDb();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        env: config.env,
        site: config.pricing.site,
        funnel: config.pricing.funnel,
      },
      'WebMachine backend listening'
    );
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // A build is several Claude calls deep. The default 2 minutes would cut the
  // free-build request off mid-generation.
  server.requestTimeout = 300_000;

  // Discord comes up after HTTP, and never blocks it. Its replies link to the
  // preview and download routes, so the server should already be serving them
  // by the time the first interaction can arrive. A Discord failure is logged
  // and swallowed inside startDiscord.
  await startDiscord();

  // ---- Graceful shutdown ------------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(async () => {
      try {
        // Close the Gateway before the database: an interaction still in
        // flight will reach for Mongo, and a dead connection there surfaces to
        // the user as a broken build rather than as a restart.
        await stopDiscord();
        await disconnectDb();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err: err.message }, 'Error during shutdown');
        process.exit(1);
      }
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason?.message || reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Failed to start');
  process.exit(1);
});
