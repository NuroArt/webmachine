'use strict';

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');

const config = require('../config');
const logger = require('../utils/logger');
const { onInteraction } = require('./handlers');

const BRAND = config.discord.brandName;

let client = null;

/**
 * THE GATEWAY CLIENT
 *
 * Runs in the same Node process as the Express server. One deploy, one
 * container, one set of env vars — and Express keeps serving the previews,
 * downloads and /health that the Discord replies link to.
 *
 * Intents: `Guilds` only.
 *
 * That matters more than it looks. Slash commands and modals are delivered as
 * interactions, which arrive regardless of intents, so the bot never needs to
 * read message content. Message Content is a privileged intent requiring
 * Discord's review and justification, and asking for it would gate this
 * deploy behind an approval queue for a capability the bot does not use.
 */
function createClient() {
  const c = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Nothing here needs a member/message/user cache; the bot reads its state
    // from Mongo. Keeping sweepers aggressive holds memory flat on a small dyno.
    sweepers: {
      messages: { interval: 300, lifetime: 60 },
    },
  });

  c.once(Events.ClientReady, (ready) => {
    logger.info(
      { tag: ready.user.tag, id: ready.user.id, guilds: ready.guilds.cache.size },
      `${BRAND} connected to Discord`
    );

    ready.user.setPresence({
      status: 'online',
      activities: [{ name: '/build — free homepage', type: ActivityType.Listening }],
    });
  });

  c.on(Events.InteractionCreate, (interaction) => {
    // Never await here. An unhandled rejection from an interaction must not
    // take down the Gateway connection for every other user.
    onInteraction(interaction).catch((err) =>
      logger.error({ err: err.message }, 'Unhandled interaction rejection')
    );
  });

  c.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));
  c.on(Events.Warn, (msg) => logger.warn({ msg }, 'Discord client warning'));

  c.on(Events.ShardDisconnect, (event, shardId) =>
    logger.warn({ shardId, code: event?.code }, 'Discord shard disconnected')
  );
  c.on(Events.ShardReconnecting, (shardId) =>
    logger.info({ shardId }, 'Discord shard reconnecting')
  );
  c.on(Events.ShardResume, (shardId, replayed) =>
    logger.info({ shardId, replayed }, 'Discord shard resumed')
  );

  return c;
}

/**
 * Logs in, if Discord is enabled.
 *
 * Returns null when disabled so the caller can boot the HTTP server either
 * way. A login failure is logged and swallowed rather than thrown: the
 * Telegram bot, the previews and the download endpoints are all still working,
 * and taking the whole process down over Discord would be a self-inflicted
 * outage for paying users.
 */
async function startDiscord() {
  if (!config.discord.enabled) {
    logger.info('Discord adapter disabled (set DISCORD_ENABLED=true to turn it on)');
    return null;
  }

  client = createClient();

  try {
    await client.login(config.discord.botToken);
    return client;
  } catch (err) {
    logger.error({ err: err.message }, 'Discord login failed — continuing without Discord');
    try {
      await client.destroy();
    } catch {
      /* already gone */
    }
    client = null;
    return null;
  }
}

async function stopDiscord() {
  if (!client) return;
  try {
    await client.destroy();
    logger.info('Discord client destroyed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error destroying Discord client');
  } finally {
    client = null;
  }
}

const getClient = () => client;

module.exports = { startDiscord, stopDiscord, getClient, createClient };
