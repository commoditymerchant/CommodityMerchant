#!/usr/bin/env node
// Fetches end-of-day commodity prices and writes them to prices.json in the
// format the redesigned homepage reads (featured copper + gold/silver/
// aluminium/brent quotes). Run daily via .github/workflows/update-prices.yml.
//
// Primary source is Yahoo Finance's chart API (price + previous close, so we
// get a real daily change). It rate-limits some datacenter IPs, so each
// symbol falls back to a keyless secondary source; when the secondary source
// has no previous close, the change is computed against the last committed
// prices.json, and failing that carries the previous value forward unchanged.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'prices.json');
const LB_PER_TONNE = 2204.62262;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// Every fetcher reports the date its observation actually belongs to, and
// nothing is published under a date it did not come from.
//
// The 10 Nov fix caught "every source threw" and marked the carried-forward
// value stale. It did not catch the commoner failure: a source that answers
// HTTP 200 with an OLD observation. FRED's DCOILBRENTEU lags about a week, so
// on 11 Nov 2026 it returned 107.03 dated 3 Nov - before Brent fell over 20%
// on Iran de-escalation - and the run went GREEN publishing it as that day's
// price. Two independent sources had Brent at 92.39 (Trading Economics, 10:50)
// and 92.49 (Oilprice.com) that morning. A gate that only watches for thrown
// errors cannot see a confident wrong answer.
const DAY_MS = 86_400_000;
// Tolerates a weekend plus a public holiday. LME officials publish after the
// session, so Westmetall's newest row is legitimately yesterday every morning;
// a tighter threshold would flag copper daily and train everyone to ignore it.
const MAX_AGE_DAYS = 4;
const today = () => new Date().toISOString().slice(0, 10);
const ageDays = (iso) => Math.round((Date.parse(today()) - Date.parse(iso)) / DAY_MS);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function yahoo(symbol, convert = (p) => p) {
  const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  if (typeof price !== 'number') throw new Error(`no price in Yahoo response for ${symbol}`);
  const t = meta?.regularMarketTime;
  return {
    px: convert(price),
    chg: typeof prev === 'number' && prev !== 0 ? round(((price - prev) / prev) * 100, 2) : null,
    asOf: typeof t === 'number' ? new Date(t * 1000).toISOString().slice(0, 10) : today(),
  };
}

async function goldApi(symbol, convert = (p) => p) {
  const data = await getJson(`https://api.gold-api.com/price/${symbol}`);
  if (typeof data.price !== 'number') throw new Error(`no price from gold-api for ${symbol}`);
  // Live spot quote: the observation is now.
  return { px: convert(data.price), chg: null, asOf: today() };
}

// Westmetall publishes LME official settlements daily (the source the
// letters cite). We take the 3-month column of the last two sessions so the
// change is a real day-over-day move. COMEX-derived numbers are NOT a
// substitute here: US copper trades at a structural tariff premium to LME.
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Westmetall prints its dates as "10. November 2026".
function westmetallDate(cell) {
  const m = cell.match(/(\d{1,2})\.\s*([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString().slice(0, 10);
}

async function westmetall(field) {
  const html = await getText(`https://www.westmetall.com/en/markdaten.php?action=table&field=${field}`);
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim());
    if (cells.length < 3 || !/\d{4}/.test(cells[0])) continue;
    const m3 = parseFloat(cells[2].replace(/,/g, ''));
    if (Number.isFinite(m3)) rows.push({ px: m3, asOf: westmetallDate(cells[0]) });
    if (rows.length === 2) break;
  }
  if (!rows.length) throw new Error(`no data from westmetall ${field}`);
  const [latest, prior] = rows;
  // An unparseable date is not evidence of freshness, so it must not read as
  // today. Leave it null and let the freshness gate withhold the quote.
  return {
    px: latest.px,
    chg: prior ? round(((latest.px - prior.px) / prior.px) * 100, 2) : null,
    asOf: latest.asOf,
  };
}

// FRED public CSV (no API key). Returns the last two valid observations so
// daily series yield a real day-over-day change.
async function fred(seriesId) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`);
  const rows = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .map(([date, value]) => ({ asOf: (date ?? '').trim(), px: parseFloat(value) }))
    .filter((r) => Number.isFinite(r.px) && /^\d{4}-\d{2}-\d{2}$/.test(r.asOf));
  if (!rows.length) throw new Error(`no data in FRED series ${seriesId}`);
  const latest = rows[rows.length - 1];
  const prior = rows.length > 1 ? rows[rows.length - 2] : null;
  // FRED is EIA-sourced and lags. Reporting the observation date is what lets
  // the caller refuse it rather than reprint last week's price as today's.
  return {
    px: latest.px,
    chg: prior ? round(((latest.px - prior.px) / prior.px) * 100, 2) : null,
    asOf: latest.asOf,
  };
}

const SYMBOLS = {
  copper:    { name: 'Copper · LME 3M', decimals: 0, primary: () => westmetall('LME_Cu_cash'), fallback: () => yahoo('HG=F', (p) => p * LB_PER_TONNE) },
  gold:      { key: 'XAU',   name: 'Gold / oz',     decimals: 2, primary: () => yahoo('GC=F'),  fallback: () => goldApi('XAU') },
  silver:    { key: 'XAG',   name: 'Silver / oz',   decimals: 2, primary: () => yahoo('SI=F'),  fallback: () => goldApi('XAG') },
  aluminium: { key: 'ALU',   name: 'Aluminium / t', decimals: 0, primary: () => westmetall('LME_Al_cash'), fallback: () => fred('PALUMUSDM') },
  brent:     { key: 'BRENT', name: 'Brent / bbl',   decimals: 2, primary: () => yahoo('BZ=F'),  fallback: () => fred('DCOILBRENTEU') },
};

let previous = {};
try {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  previous.asOf = prev.asOf ?? null;
  previous.copper = prev.featured;
  for (const q of prev.quotes ?? []) {
    for (const [k, cfg] of Object.entries(SYMBOLS)) if (cfg.key === q.key) previous[k] = q;
  }
  // A quote withheld yesterday is absent from quotes[], so its last known price
  // would otherwise be lost and the day-change on recovery would come out 0.
  for (const w of prev.withheld ?? []) {
    for (const [k, cfg] of Object.entries(SYMBOLS)) {
      if ((cfg.key ?? k) === w.key && w.lastPx != null) {
        previous[k] = { px: w.lastPx, asOf: w.lastAsOf ?? null };
      }
    }
  }
} catch {
  // first run, or file missing — changes fall back to 0
}

const results = {};
const withheld = [];

// Carrying a dead feed's last value forward was the old behaviour, and it is
// the thing being removed. The homepage has no way to render a stale quote -
// "stale" appears nowhere in index.html - so a flag in prices.json is invisible
// to the only audience that matters. The reader just sees a confident number
// under today's date. A commodity publication can be missing a price; it cannot
// print a wrong one. So a quote that cannot be sourced fresh is WITHHELD, and
// the file records what is missing and why.
function withhold(key, reason) {
  const prev = previous[key];
  withheld.push({
    key: SYMBOLS[key].key ?? key,
    name: SYMBOLS[key].name,
    reason,
    lastPx: prev?.px ?? null,
    lastAsOf: prev?.asOf ?? previous.asOf ?? null,
  });
  console.error(`[${key}] withheld: ${reason}`);
}

for (const [key, cfg] of Object.entries(SYMBOLS)) {
  let entry;
  try {
    entry = await cfg.primary();
  } catch (ePrimary) {
    try {
      entry = await cfg.fallback();
      console.warn(`[${key}] primary failed (${ePrimary.message}), used fallback`);
    } catch (eFallback) {
      withhold(key, `all sources failed (${eFallback.message})`);
      continue;
    }
  }

  // The check the 10 Nov fix was missing: a source can answer 200 with an old
  // observation, and that is indistinguishable from a fresh one unless the date
  // travels with the price.
  if (!entry.asOf) {
    withhold(key, 'source returned no observation date');
    continue;
  }
  const age = ageDays(entry.asOf);
  if (age > MAX_AGE_DAYS) {
    withhold(key, `newest observation is ${entry.asOf}, ${age} days old`);
    continue;
  }

  if (entry.chg === null) {
    const prevPx = previous[key]?.px;
    entry.chg = prevPx ? round(((entry.px - prevPx) / prevPx) * 100, 2) : 0;
  }
  entry.px = round(entry.px, cfg.decimals);
  results[key] = entry;
}

// Copper is the headline tile and the page cannot render without it. If it
// cannot be sourced fresh, publish nothing at all: leaving yesterday's file in
// place keeps the site honest, because that file still carries yesterday's date.
if (!results.copper) {
  console.error('copper could not be sourced fresh; leaving prices.json untouched');
  process.exit(1);
}

const published = ['copper', 'gold', 'silver', 'aluminium', 'brent'].filter((k) => results[k]);

const out = {
  // The oldest observation actually published, never today by default. The page
  // must not claim more freshness than the data behind it has.
  asOf: published.map((k) => results[k].asOf).sort()[0],
  note: 'Indicative levels. Refreshed daily by an automated workflow; gold and silver also refresh live in the browser when the quote feed is reachable.',
  featured: {
    name: SYMBOLS.copper.name, px: results.copper.px, chg: results.copper.chg,
    decimals: SYMBOLS.copper.decimals, asOf: results.copper.asOf,
  },
  quotes: ['gold', 'silver', 'aluminium', 'brent']
    .filter((k) => results[k])
    .map((k) => ({
      key: SYMBOLS[k].key, name: SYMBOLS[k].name, px: results[k].px, chg: results[k].chg,
      decimals: SYMBOLS[k].decimals, asOf: results[k].asOf,
    })),
  ...(withheld.length ? { withheld } : {}),
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}:`);
console.log(JSON.stringify(out, null, 2));

// Deliberately exit 0. Failing here would skip the commit, push and deploy,
// holding the good prices hostage to one dead feed. The workflow's final step
// reads the written file and reds the job after the data has shipped.
if (withheld.length) {
  console.error(
    `\nWITHHELD: ${withheld.map((w) => `${w.name} (${w.reason})`).join('; ')}` +
    `\nThese quotes are absent from the site rather than wrong. Fix the feed or retire the tile.`
  );
}
