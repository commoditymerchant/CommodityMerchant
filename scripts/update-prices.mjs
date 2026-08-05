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
  return {
    px: convert(price),
    chg: typeof prev === 'number' && prev !== 0 ? round(((price - prev) / prev) * 100, 2) : null,
  };
}

async function goldApi(symbol, convert = (p) => p) {
  const data = await getJson(`https://api.gold-api.com/price/${symbol}`);
  if (typeof data.price !== 'number') throw new Error(`no price from gold-api for ${symbol}`);
  return { px: convert(data.price), chg: null };
}

// Westmetall publishes LME official settlements daily (the source the
// letters cite). We take the 3-month column of the last two sessions so the
// change is a real day-over-day move. COMEX-derived numbers are NOT a
// substitute here: US copper trades at a structural tariff premium to LME.
async function westmetall(field) {
  const html = await getText(`https://www.westmetall.com/en/markdaten.php?action=table&field=${field}`);
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim());
    if (cells.length < 3 || !/\d{4}/.test(cells[0])) continue;
    const m3 = parseFloat(cells[2].replace(/,/g, ''));
    if (Number.isFinite(m3)) rows.push(m3);
    if (rows.length === 2) break;
  }
  if (!rows.length) throw new Error(`no data from westmetall ${field}`);
  const [px, prev] = rows;
  return { px, chg: prev ? round(((px - prev) / prev) * 100, 2) : null };
}

// FRED public CSV (no API key). Returns the last two valid observations so
// daily series yield a real day-over-day change.
async function fred(seriesId) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`);
  const values = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => parseFloat(line.split(',')[1]))
    .filter((v) => Number.isFinite(v));
  if (!values.length) throw new Error(`no data in FRED series ${seriesId}`);
  const px = values[values.length - 1];
  const prev = values.length > 1 ? values[values.length - 2] : null;
  return { px, chg: prev ? round(((px - prev) / prev) * 100, 2) : null };
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
  previous.copper = prev.featured;
  for (const q of prev.quotes ?? []) {
    for (const [k, cfg] of Object.entries(SYMBOLS)) if (cfg.key === q.key) previous[k] = q;
  }
} catch {
  // first run, or file missing — changes fall back to 0
}

const results = {};
let failures = 0;

for (const [key, cfg] of Object.entries(SYMBOLS)) {
  let entry;
  try {
    entry = await cfg.primary();
  } catch (ePrimary) {
    try {
      entry = await cfg.fallback();
      console.warn(`[${key}] primary failed (${ePrimary.message}), used fallback`);
    } catch (eFallback) {
      console.error(`[${key}] all sources failed: ${eFallback.message}`);
      failures++;
      if (previous[key]) results[key] = { px: previous[key].px, chg: previous[key].chg };
      continue;
    }
  }
  if (entry.chg === null) {
    const prevPx = previous[key]?.px;
    entry.chg = prevPx ? round(((entry.px - prevPx) / prevPx) * 100, 2) : 0;
  }
  entry.px = round(entry.px, cfg.decimals);
  results[key] = entry;
}

if (failures === Object.keys(SYMBOLS).length) {
  console.error('every symbol failed; leaving prices.json untouched');
  process.exit(1);
}

const out = {
  asOf: new Date().toISOString().slice(0, 10),
  note: 'Indicative levels. Refreshed daily by an automated workflow; gold and silver also refresh live in the browser when the quote feed is reachable.',
  featured: { name: SYMBOLS.copper.name, px: results.copper.px, chg: results.copper.chg, decimals: SYMBOLS.copper.decimals },
  quotes: ['gold', 'silver', 'aluminium', 'brent']
    .filter((k) => results[k])
    .map((k) => ({ key: SYMBOLS[k].key, name: SYMBOLS[k].name, px: results[k].px, chg: results[k].chg, decimals: SYMBOLS[k].decimals })),
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}:`);
console.log(JSON.stringify(out, null, 2));
