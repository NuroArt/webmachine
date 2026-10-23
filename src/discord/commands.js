'use strict';

const { SlashCommandBuilder } = require('discord.js');

const config = require('../config');

const BRAND = config.discord.brandName;

/**
 * THE SLASH COMMANDS
 *
 * Deliberately four. Every command is a thing to maintain, and `/build` is
 * the product — the rest exist so a new user can orient without reading docs.
 *
 * None of these take options. `/build` opens a modal instead, which is the one
 * real ergonomic win Discord has over Telegram here: the Telegram bot walks
 * the user through four questions as four separate messages and has to persist
 * half-finished intake on the user document to survive a redeploy. A modal
 * collects all four at once and arrives as a single atomic submission, so
 * there is no intake state to keep and nothing to lose mid-conversation.
 */
const commands = [
  new SlashCommandBuilder()
    .setName('build')
    .setDescription(`Build a free homepage with ${BRAND} — four questions, about a minute`)
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('builds')
    .setDescription('Your recent builds and their preview links')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('pricing')
    .setDescription('What the free build includes, and what the full five pages cost')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription(`How ${BRAND} works`)
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Delete your builds and personal details from this bot')
    .setDMPermission(true),
];

/** The JSON payload the registration script PUTs to Discord. */
function toJSON() {
  return commands.map((c) => c.toJSON());
}

module.exports = { commands, toJSON, BRAND };
