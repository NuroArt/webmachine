'use strict';

const config = require('./config');
const logger = require('./utils/logger');
const { connectDb, disconnectDb } = require('./db/connect');
const { createApp } = require('./app');

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
