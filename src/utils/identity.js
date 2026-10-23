'use strict';

/**
 * PLATFORM-SCOPED USER IDS
 *
 * Telegram id 12345 and Discord id 12345 are different people. The old schema
 * keyed users on a bare id string with a unique index, so the moment a second
 * platform exists those two collide onto one row — one owner inherits the
 * other's builds, free-build quota and referral code.
 *
 * The fix is a composite key: "<platform>:<rawId>". It stays a single string,
 * so every existing query, index and comparison keeps working unchanged. The
 * denormalized `platform` field on each document exists only so analytics can
 * group without parsing strings.
 *
 * `normalizeUserId` treats a bare id as Telegram. That is what makes this
 * change backward compatible: the Telegram webhook still passes
 * `String(message.from.id)` and lands on the same row it always did, provided
 * the existing rows have been prefixed. Run scripts/migratePlatform.js once.
 */

const PLATFORMS = Object.freeze(['telegram', 'discord']);

const DEFAULT_PLATFORM = 'telegram';

/** Matches an already-composite id so normalizing twice is a no-op. */
const COMPOSITE = new RegExp(`^(${PLATFORMS.join('|')}):(.+)$`);

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return platform;
}

/** Builds a composite id from a platform and that platform's raw user id. */
function composeUserId(platform, rawId) {
  assertPlatform(platform);
  const raw = String(rawId ?? '').trim();
  if (!raw) throw new Error('composeUserId requires a raw user id');
  if (raw.includes(':')) {
    // A raw id should never contain a colon on either platform (both are
    // numeric snowflakes). If one does, it is already composite or malformed.
    const already = raw.match(COMPOSITE);
    if (already) return raw;
    throw new Error(`Raw user id may not contain ":" (got ${raw})`);
  }
  return `${platform}:${raw}`;
}

/**
 * Coerces any id into composite form.
 *
 * Already-composite ids pass through untouched. A bare id is assumed to be
 * Telegram, which keeps every pre-existing call site correct.
 */
function normalizeUserId(id, defaultPlatform = DEFAULT_PLATFORM) {
  const s = String(id ?? '').trim();
  if (!s) throw new Error('normalizeUserId requires an id');
  if (COMPOSITE.test(s)) return s;
  return composeUserId(defaultPlatform, s);
}

/** Splits a composite id. A bare id reads as Telegram. */
function parseUserId(id) {
  const s = String(id ?? '').trim();
  const m = s.match(COMPOSITE);
  if (m) return { platform: m[1], rawId: m[2] };
  return { platform: DEFAULT_PLATFORM, rawId: s };
}

/** The platform half of a composite id. */
function platformOf(id) {
  return parseUserId(id).platform;
}

/** The raw platform id, for calling that platform's API back. */
function rawIdOf(id) {
  return parseUserId(id).rawId;
}

module.exports = {
  PLATFORMS,
  DEFAULT_PLATFORM,
  composeUserId,
  normalizeUserId,
  parseUserId,
  platformOf,
  rawIdOf,
};
