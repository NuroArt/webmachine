'use strict';

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const config = require('../config');
const logger = require('../utils/logger');
const service = require('../build/service');
const { composeUserId } = require('../utils/identity');
const { PRODUCTS_BY_ID, usdApprox } = require('../catalog/products');
const { budgetExceeded } = require('../claude/client');

const BRAND = config.discord.brandName;
const ACCENT = 0x5865f2;
const WARN = 0xfaa61a;
const BAD = 0xed4245;

const MODAL_ID = 'fivepage:intake';
const FORGET_ID = 'fivepage:forget:confirm';

/**
 * The only product Discord sells is the free one.
 *
 * Pinned to the catalog rather than a literal so a pricing change in
 * catalog/products.js cannot silently turn the Discord free tier into a paid
 * build that nobody can pay for.
 */
const FREE_PRODUCT = PRODUCTS_BY_ID.preview;

/** The paid tier, named in copy only. Discord has no rail to sell it on. */
const PAID_PRODUCT = PRODUCTS_BY_ID.site;

/** Discord's free-tier attachment ceiling. Below it we attach, above we link. */
const ATTACH_LIMIT_BYTES = 9.5 * 1024 * 1024;

/* ────────────────────────────────────────────────────────────
   IDENTITY
   ──────────────────────────────────────────────────────────── */

const idOf = (interaction) => composeUserId('discord', interaction.user.id);

const profileOf = (interaction) => ({
  username: interaction.user.username,
  firstName: interaction.user.globalName || interaction.user.username,
  languageCode: interaction.locale || null,
});

/* ────────────────────────────────────────────────────────────
   /build — THE MODAL
   ──────────────────────────────────────────────────────────── */

function buildModal() {
  const row = (input) => new ActionRowBuilder().addComponents(input);

  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle(`${BRAND} — build a page`.slice(0, 45))
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('business')
          .setLabel('What is the business called, and what is it?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(600)
          .setPlaceholder('Northside Mobile Detailing — we clean cars at your home or office.')
      ),
      row(
        new TextInputBuilder()
          .setCustomId('offer')
          .setLabel('What does it sell? Include the price.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(600)
          .setPlaceholder('Full interior + exterior detail, $180. Monthly plan $120/mo.')
      ),
      row(
        new TextInputBuilder()
          .setCustomId('audience')
          .setLabel('Who buys it? Be specific.')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(300)
          .setPlaceholder('Busy professionals, 30-55, who lease and want resale value')
      ),
      row(
        new TextInputBuilder()
          .setCustomId('style')
          .setLabel('Style? Or leave blank and I will pick.')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('clean and premium')
      )
    );
}

/**
 * Opens the intake modal.
 *
 * Discord cancels an interaction that is not answered within 3 seconds, and
 * `showModal` IS the answer — it cannot be deferred first. So the quota check
 * races a short timer: if Mongo answers quickly we can turn someone away
 * before they type four fields, and if it does not, the modal opens anyway and
 * the authoritative check runs on submit. Blocking the modal on a slow
 * database would trade a small UX win for "application did not respond".
 */
async function handleBuildCommand(interaction) {
  if (budgetExceeded()) {
    await interaction.reply({
      content: `${BRAND} is paused for a few hours — the daily generation budget is spent. Try again later.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const preflight = await raceWithTimeout(quotaPreflight(interaction), 1200, null);

  if (preflight && preflight.exhausted) {
    const hrs = Math.max(1, Math.ceil(preflight.resetsInSeconds / 3600));
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(WARN)
          .setTitle('Free build already used today')
          .setDescription(
            [
              `Your next free page unlocks in about **${hrs} hour${hrs === 1 ? '' : 's'}**.`,
              '',
              upsellLine() || 'Run `/builds` to see what you already made.',
            ].join('\n')
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildModal());
}

async function quotaPreflight(interaction) {
  const user = await service.loadOwner(idOf(interaction), profileOf(interaction));
  const left = service.freeBuildsLeft(user);
  return {
    exhausted: left <= 0,
    resetsInSeconds: service.freeWindowResetsIn(user),
  };
}

/** Resolves `fallback` if the promise has not settled in time. Never rejects. */
function raceWithTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/* ────────────────────────────────────────────────────────────
   MODAL SUBMIT — THE BUILD
   ──────────────────────────────────────────────────────────── */

/**
 * Runs a build and delivers it.
 *
 * `deferReply` goes first and takes no arguments it has to compute, because
 * everything after it is slow: a generation is several Claude calls and takes
 * about a minute. Deferring buys a 15-minute window to respond, which is far
 * more headroom than GENERATION_TIMEOUT_MS needs.
 *
 * The reply is public in a guild on purpose. A finished page appearing in a
 * channel is the only organic distribution this bot gets, and it is the whole
 * reason to be on Discord rather than only Telegram.
 */
async function handleModalSubmit(interaction) {
  await interaction.deferReply();

  const userId = idOf(interaction);

  const inputs = {
    business: interaction.fields.getTextInputValue('business'),
    offer: interaction.fields.getTextInputValue('offer'),
    audience: safeField(interaction, 'audience'),
    style: safeField(interaction, 'style'),
  };

  // Authoritative checks, now that we are no longer racing the 3-second clock.
  const user = await service.loadOwner(userId, profileOf(interaction));

  if (service.freeBuildsLeft(user) <= 0) {
    const hrs = Math.max(1, Math.ceil(service.freeWindowResetsIn(user) / 3600));
    await edit(interaction, {
      embeds: [
        new EmbedBuilder()
          .setColor(WARN)
          .setTitle('Free build already used today')
          .setDescription(`Your next free page unlocks in about **${hrs} hour${hrs === 1 ? '' : 's'}**.`),
      ],
    });
    return;
  }

  const claimed = await service.claimBuildSlot(userId);
  if (!claimed) {
    await edit(interaction, {
      content: 'A build is already running for you. Give it a minute.',
    });
    return;
  }

  const started = Date.now();
  let result;

  try {
    result = await service.runBuild({
      userId,
      productId: FREE_PRODUCT.productId,
      inputs,
      source: 'free',
      onProgress: ({ stage, label }) => {
        const icon = { brief: '🧭', pages: '✍️', css: '🎨', assemble: '📦' }[stage] || '⚙️';
        // Fire and forget. A dropped progress edit must never abort a build,
        // and Discord rate-limits edits per channel.
        edit(interaction, { content: `${icon} ${label}…` }).catch(() => {});
      },
    });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Discord build threw');
    result = { ok: false, error: err.message };
  } finally {
    await service.releaseBuildSlot(userId);
  }

  if (!result.ok) {
    await edit(interaction, {
      embeds: [
        new EmbedBuilder()
          .setColor(BAD)
          .setTitle('That build failed')
          .setDescription(
            [
              'Nothing was charged — the Discord build is always free.',
              '',
              'Run `/build` to try again. If it fails twice, the wording of the',
              'business description is usually what trips it.',
            ].join('\n')
          ),
      ],
    });
    return;
  }

  await deliver(interaction, result.site, Date.now() - started);
}

/** An optional modal field that may be absent entirely. */
function safeField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id) || '';
  } catch {
    return '';
  }
}

/* ────────────────────────────────────────────────────────────
   DELIVERY
   ──────────────────────────────────────────────────────────── */

async function deliver(interaction, site, ms) {
  const urls = service.publicUrls(site);
  const pages = site.fileNames().filter((f) => f.endsWith('.html'));

  const lines = [`**${pages.length} page** generated in ${(ms / 1000).toFixed(0)}s.`];

  if (urls.previewUrl) lines.push('', `👀 **[Open the live preview](${urls.previewUrl})**`);

  const warnings = (site.generationNotes || []).filter(
    (n) => n.includes('token limit') || n.includes('unclosed') || n.includes('placeholder')
  );
  if (warnings.length) {
    lines.push('', '⚠️ Worth a look before you publish:', ...warnings.map((w) => `• ${w}`));
  }

  const upsell = upsellLine();
  if (upsell) lines.push('', upsell);

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`🎯 ${site.businessName || 'Your page'} is ready`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${BRAND} · one free page per day` });

  /* ---- attach the zip, or fall back to the download link ------------- */
  const files = [];
  try {
    const zip = await service.zipBuild(site);

    if (zip.length <= ATTACH_LIMIT_BYTES) {
      files.push(
        new AttachmentBuilder(zip, {
          name: `${service.safeFolderName(site.businessName)}.zip`,
          description: 'Extract, then open index.html. Styling is inlined.',
        })
      );
    } else if (urls.downloadUrl) {
      embed.addFields({
        name: 'Download',
        value: `Too large to attach here — [download the .zip](${urls.downloadUrl})`,
      });
    }
  } catch (err) {
    logger.error({ err: err.message, siteId: site._id.toString() }, 'Discord zip failed');
    if (urls.downloadUrl) {
      embed.addFields({
        name: 'Download',
        value: `[Download the .zip](${urls.downloadUrl})`,
      });
    }
  }

  await edit(interaction, { content: '', embeds: [embed], files });
}

/**
 * The cross-platform upsell.
 *
 * Discord has no payment rail here, so the other four pages are sold on
 * Telegram where Stars work. Rendered only when TELEGRAM_BOT_USERNAME is set,
 * so a missing env var produces no line rather than a dead link.
 */
function upsellLine() {
  if (!config.telegram.botUsername) return '';
  const url = `https://t.me/${config.telegram.botUsername}`;
  return (
    `That is 1 of 5. The full site — About, Services, Pricing, Contact, ` +
    `linked with working nav — is **${PAID_PRODUCT.starCost} ⭐ ` +
    `(${usdApprox(PAID_PRODUCT.starCost)})** on [Telegram](${url}).`
  );
}

/* ────────────────────────────────────────────────────────────
   /builds, /pricing, /help
   ──────────────────────────────────────────────────────────── */

async function handleBuildsCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sites = await service.listSites(idOf(interaction), 10);

  if (!sites.length) {
    await edit(interaction, { content: 'No builds yet. Run `/build`.' });
    return;
  }

  const lines = sites.map((s) => {
    const urls = service.publicUrls(s);
    const mark = s.status === 'ready' ? '✅' : s.status === 'failed' ? '⚠️' : '⏳';
    const link = urls.previewUrl && s.status === 'ready' ? ` — [preview](${urls.previewUrl})` : '';
    return `${mark} **${s.businessName || s.name}** · ${s.pageCount}pp${link}`;
  });

  await edit(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Your builds')
        .setDescription(lines.join('\n'))
        .setFooter({ text: BRAND }),
    ],
  });
}

async function handlePricingCommand(interaction) {
  const site = PRODUCTS_BY_ID.site;
  const funnel = PRODUCTS_BY_ID.funnel;

  const body = [
    `**Free here on Discord** — one real page, one per day.`,
    ...FREE_PRODUCT.includes.map((i) => `• ${i}`),
    '',
  ];

  if (config.telegram.botUsername) {
    const url = `https://t.me/${config.telegram.botUsername}`;
    body.push(
      `**On [Telegram](${url})**, where payment works:`,
      `• **${site.name}** — ${site.starCost} ⭐ (${usdApprox(site.starCost)}) — ${site.tagline}`,
      `• **${funnel.name}** — ${funnel.starCost} ⭐ (${usdApprox(funnel.starCost)}) — ${funnel.tagline}`,
      '',
      'Both come with an instant, no-questions refund.'
    );
  } else {
    body.push('The full five-page site is not on sale here yet.');
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder().setColor(ACCENT).setTitle('What things cost').setDescription(body.join('\n')),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/* ────────────────────────────────────────────────────────────
   /forget — ERASURE
   ──────────────────────────────────────────────────────────── */

/**
 * Two steps, unlike /refund.
 *
 * A refund is reversible — you can buy again. This is not: it destroys the
 * generated pages and kills every preview link. An irreversible action
 * reached by one mistyped slash command is a support ticket waiting to
 * happen, so it takes a deliberate second click.
 */
async function handleForgetCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sites = await service.listSites(idOf(interaction), 50);

  if (!sites.length) {
    await edit(interaction, {
      content: 'There is nothing stored for you beyond your Discord user id.',
    });
    return;
  }

  await edit(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(WARN)
        .setTitle('Delete your data?')
        .setDescription(
          [
            `This removes **${sites.length} build${sites.length === 1 ? '' : 's'}**, the`,
            'business details you typed in, and your saved name.',
            '',
            '**Every preview link you have shared will stop working.**',
            'Download anything you still want first — `/builds` has the links.',
            '',
            'Your daily free-build count is kept, so this cannot be used to',
            'reset the limit. Payment records are kept but stripped of',
            'anything you wrote.',
            '',
            'This cannot be undone.',
          ].join('\n')
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(FORGET_ID)
          .setLabel('Delete everything')
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });
}

async function handleForgetConfirm(interaction) {
  await interaction.deferUpdate();

  const result = await service.deleteUserData(idOf(interaction));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Deleted')
        .setDescription(
          [
            `${result.sitesDeleted} build${result.sitesDeleted === 1 ? '' : 's'} removed, along`,
            'with everything you typed. Preview links are dead.',
            '',
            'Run `/build` any time to start fresh.',
          ].join('\n')
        ),
    ],
    components: [],
  });
}

async function handleHelpCommand(interaction) {
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle(`How ${BRAND} works`)
        .setDescription(
          [
            '`/build` — four questions in one form, then about a minute of work.',
            '`/builds` — your past builds and preview links.',
            '`/pricing` — what the free build includes.',
            '`/forget` — delete your builds and details.',
            '',
            'You get a live preview link plus a `.zip`. Every page carries its own',
            'styling inline, so you can open the `.html` straight out of the folder',
            'and it still looks right — no build step, no server, host it anywhere.',
            '',
            'One free page per day, per person.',
          ].join('\n')
        )
        .setFooter({ text: BRAND }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/* ────────────────────────────────────────────────────────────
   ROUTING
   ──────────────────────────────────────────────────────────── */

const COMMANDS = {
  build: handleBuildCommand,
  builds: handleBuildsCommand,
  pricing: handlePricingCommand,
  help: handleHelpCommand,
  forget: handleForgetCommand,
};

/**
 * Single entry point for every interaction.
 *
 * Anything that throws past here leaves the user staring at "application did
 * not respond", so the catch always tries to say something — and has to pick
 * reply vs editReply based on whether the interaction was already answered.
 */
async function onInteraction(interaction) {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== MODAL_ID) return;
      await handleModalSubmit(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId !== FORGET_ID) return;
      await handleForgetConfirm(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const handler = COMMANDS[interaction.commandName];
    if (!handler) return;

    await handler(interaction);
  } catch (err) {
    logger.error(
      {
        err: err.message,
        stack: err.stack,
        command: interaction.commandName || interaction.customId,
        userId: interaction.user?.id,
      },
      'Discord interaction failed'
    );

    await apologize(interaction).catch(() => {});
  }
}

async function apologize(interaction) {
  const payload = {
    content: 'Something broke on my end. Nothing was charged. Try `/build` again.',
    embeds: [],
    files: [],
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Edits the deferred reply, falling back to a DM.
 *
 * An interaction token dies after 15 minutes, and a process restart mid-build
 * loses it outright. The build itself is already saved either way, so the DM
 * is about telling the user where it went rather than about the artifact.
 */
async function edit(interaction, payload) {
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    logger.warn({ err: err.message }, 'editReply failed; trying DM');
    try {
      return await interaction.user.send({
        ...payload,
        content: [payload.content, '', '_(Your build finished after the command timed out.)_']
          .filter(Boolean)
          .join('\n'),
      });
    } catch {
      return null;
    }
  }
}

module.exports = {
  onInteraction,
  buildModal,
  upsellLine,
  MODAL_ID,
  FORGET_ID,
  FREE_PRODUCT,
  ATTACH_LIMIT_BYTES,
  /** Routed command names, so a test can assert none drifted from commands.js. */
  COMMAND_NAMES: Object.keys(COMMANDS),
  // exported for tests
  handleBuildCommand,
  handleModalSubmit,
  handleBuildsCommand,
  raceWithTimeout,
};
