'use strict';

/** 12400 -> "12.4K". For counters the Mini App shows in tight space. */
function compact(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(Math.floor(n));
  const units = [
    { v: 1e12, s: 'T' },
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ];
  for (const u of units) {
    if (n >= u.v) {
      const scaled = n / u.v;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${u.s}`;
    }
  }
  return String(Math.floor(n));
}

function withCommas(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

/** 1536 -> "1.5 KB". Build sizes. */
function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 74000 -> "1m 14s". Generation times. */
function duration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function shortDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function stars(n) {
  return `${withCommas(n)} ⭐`;
}

module.exports = { compact, withCommas, bytes, duration, shortDate, stars };
