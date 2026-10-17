'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');
const { Errors } = require('../utils/errors');

let client = null;

/** Sonnet pricing, USD per million tokens. Used for the daily spend cap. */
const RATE_IN = 3.0;
const RATE_OUT = 15.0;

function getClient() {
  if (!client) {
    if (!config.anthropic.apiKey) {
      throw Errors.upstream('ANTHROPIC_API_KEY is not configured');
    }
    client = new Anthropic({
      apiKey: config.anthropic.apiKey,
      maxRetries: 3,
      timeout: 120_000,
    });
  }
  return client;
}

/** Rolling daily spend, reset lazily. The circuit breaker reads this. */
const spend = { usd: 0, day: new Date().toDateString() };

function recordSpend(usage = {}) {
  const today = new Date().toDateString();
  if (spend.day !== today) {
    spend.day = today;
    spend.usd = 0;
  }
  const cost =
    ((usage.input_tokens || 0) / 1e6) * RATE_IN + ((usage.output_tokens || 0) / 1e6) * RATE_OUT;
  spend.usd += cost;
  return cost;
}

function spendToday() {
  const today = new Date().toDateString();
  if (spend.day !== today) return 0;
  return spend.usd;
}

function budgetExceeded() {
  return spendToday() >= config.build.dailyUsdCap;
}

/** Test seam: lets the self-test reset the breaker without reaching into state. */
function resetSpend() {
  spend.day = new Date().toDateString();
  spend.usd = 0;
}

/**
 * Single entry point for every Claude call in this service.
 *
 * @param {object}   opts
 * @param {string}   opts.system
 * @param {Array}    opts.messages
 * @param {number}  [opts.maxTokens]
 * @param {number}  [opts.temperature]
 * @param {string}  [opts.prefill]   Assistant prefill to force a shape (e.g. '{')
 * @param {string}  [opts.label]     For logs only
 * @returns {Promise<{text,usage,model,stopReason,truncated,ms,costUsd}>}
 */
async function complete({ system, messages, maxTokens, temperature = 0.7, prefill, label }) {
  const started = Date.now();
  const anthropic = getClient();

  const finalMessages = prefill ? [...messages, { role: 'assistant', content: prefill }] : messages;

  let response;
  try {
    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens || config.anthropic.maxTokens,
      temperature,
      system,
      messages: finalMessages,
    });
  } catch (err) {
    logger.error({ err: err.message, status: err.status, label }, 'Claude API call failed');
    if (err.status === 429) throw Errors.rateLimited('Claude is rate limited. Try again shortly.');
    throw Errors.upstream(`Claude API error: ${err.message}`);
  }

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const costUsd = recordSpend(response.usage);

  /**
   * `max_tokens` means the model was cut off mid-sentence. For generated HTML
   * that produces a page with an unclosed tag, so callers must surface it
   * rather than shipping silently broken markup.
   */
  const truncated = response.stop_reason === 'max_tokens';
  if (truncated) logger.warn({ label }, 'Claude response hit max_tokens and was truncated');

  return {
    // Re-attach the prefill so callers parsing JSON get a complete document.
    text: prefill ? prefill + text : text,
    usage: response.usage || {},
    model: response.model,
    stopReason: response.stop_reason,
    truncated,
    ms: Date.now() - started,
    costUsd,
  };
}

/**
 * Extracts the first balanced JSON object from a model response.
 * Tolerates fenced code blocks and leading prose, which is what makes the
 * brief step robust without asking the model for a second attempt.
 */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  let s = text.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Pulls HTML out of a response that may be fenced or wrapped in prose.
 * Returns the markup between the outermost recognisable boundaries.
 */
function extractHtml(text) {
  if (typeof text !== 'string' || !text.trim()) return '';

  let s = text.trim();

  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // If the model wrote a full document anyway, keep only the body contents.
  const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body) return body[1].trim();

  // Otherwise drop any leading prose before the first tag.
  const firstTag = s.indexOf('<');
  if (firstTag > 0) s = s.slice(firstTag);

  return s.trim();
}

/** Same, for a stylesheet: strips fences and any stray <style> wrapper. */
function extractCss(text) {
  if (typeof text !== 'string' || !text.trim()) return '';

  let s = text.trim();

  const fence = s.match(/```(?:css)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const style = s.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (style) s = style[1].trim();

  return s.trim();
}

module.exports = {
  getClient,
  complete,
  extractJson,
  extractHtml,
  extractCss,
  spendToday,
  budgetExceeded,
  resetSpend,
};
