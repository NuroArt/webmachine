'use strict';

/**
 * Registers the slash commands with Discord.
 *
 * Commands are not registered by the running bot — they are PUT to Discord's
 * API once, out of band, and persist until changed. Running this on every boot
 * would burn rate limit on an identical payload.
 *
 *   node scripts/registerDiscord.js            # global (all servers + DMs)
 *   node scripts/registerDiscord.js --dev      # DISCORD_DEV_GUILD_ID only
 *   node scripts/registerDiscord.js --clear    # remove all commands
 *
 * Use --dev while iterating: guild commands appear immediately, global ones
 * can take up to an hour to propagate. Register globally for launch.
 */

const { REST, Routes } = require('discord.js');

const config = require('../src/config');
const { toJSON, BRAND } = require('../src/discord/commands');

const DEV = process.argv.includes('--dev');
const CLEAR = process.argv.includes('--clear');

async function main() {
  const { botToken, applicationId, devGuildId } = config.discord;

  if (!botToken) throw new Error('DISCORD_BOT_TOKEN is not set');
  if (!applicationId) throw new Error('DISCORD_APPLICATION_ID is not set');
  if (DEV && !devGuildId) throw new Error('DISCORD_DEV_GUILD_ID is not set (needed for --dev)');

  const rest = new REST({ version: '10' }).setToken(botToken);

  const route = DEV
    ? Routes.applicationGuildCommands(applicationId, devGuildId)
    : Routes.applicationCommands(applicationId);

  const body = CLEAR ? [] : toJSON();

  const scope = DEV ? `guild ${devGuildId}` : 'globally';

  if (CLEAR) {
    await rest.put(route, { body: [] });
    console.log(`\nCleared all ${BRAND} commands ${scope}.\n`);
    return;
  }

  const result = await rest.put(route, { body });

  console.log(`\nRegistered ${result.length} ${BRAND} command(s) ${scope}:\n`);
  for (const cmd of result) {
    console.log(`  /${cmd.name.padEnd(10)} ${cmd.description}`);
  }

  if (!DEV) {
    console.log('\nGlobal commands can take up to an hour to appear everywhere.');
    console.log('Use --dev against a test server for instant iteration.');
  }

  console.log(
    `\nInvite URL:\n  https://discord.com/oauth2/authorize` +
      `?client_id=${applicationId}&scope=applications.commands%20bot&permissions=0\n`
  );
  console.log('Permissions 0 is deliberate: the bot only answers interactions.\n');
}

/** The invite URL, printed on success and on the errors it would have fixed. */
function inviteUrl() {
  return (
    `https://discord.com/oauth2/authorize` +
    `?client_id=${config.discord.applicationId}&scope=applications.commands%20bot&permissions=0`
  );
}

main().catch((err) => {
  console.error('\nRegistration failed:', err.message);

  const code = err.code ?? err.rawError?.code;

  /**
   * 50001 Missing Access on a GUILD registration almost always means one
   * thing: the app is not in that server yet. Guild commands can only be
   * written to a guild the app has been authorized into.
   *
   * The invite URL used to be printed only after a SUCCESSFUL registration,
   * which is precisely backwards — the person who needs it is the one who
   * just failed.
   */
  if (code === 50001 && DEV) {
    console.error(
      [
        '',
        'The app is not in that server yet. Guild commands can only be',
        'registered into a server the app has already been added to.',
        '',
        'Open this and add it to your test server, then run this again:',
        '',
        `  ${inviteUrl()}`,
        '',
        'If the link does nothing, Public Bot is off and you are not the app',
        'owner on the Discord account you are signed in as.',
        '',
        'Alternatively, register globally instead — that needs no server:',
        '',
        '  npm run register:discord',
        '',
      ].join('\n')
    );
  } else if (code === 50001) {
    console.error(
      '\nThe token is valid but lacks access. Check that DISCORD_APPLICATION_ID\n' +
        'belongs to the same app as DISCORD_BOT_TOKEN.\n'
    );
  } else if (err.status === 401 || /unauthorized/i.test(err.message || '')) {
    console.error(
      [
        '',
        'The bot token was rejected.',
        '',
        'A bot token is about 70 characters in three dot-separated parts.',
        'A 64-character string with no dots is the PUBLIC KEY, which is a',
        'different value and will not work here. The token lives on the Bot',
        'page, not General Information, and is shown only once per reset.',
        '',
      ].join('\n')
    );
  } else if (err.rawError) {
    console.error(JSON.stringify(err.rawError, null, 2));
  }

  process.exit(1);
});
