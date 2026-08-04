#!/usr/bin/env node
// Fetches end-of-day commodity prices and writes them to api/prices (JSON),
// which the homepage ticker reads. Run daily via .github/workflows/update-prices.yml.
//
// Primary source is Yahoo Finance's chart API (price + previous close, so we
// get a real daily change). It rate-limits some datacenter IPs, so each
// symbol falls back to a keyless secondary source; when the secondary source
// has no previous close, the change is computed against the last committed
// api/prices, and failing that carries the previous value forward unchanged.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'api', 'prices');
const LB_PER_TONNE = 2204.62262;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const round2 = (n) => Math.round(n * 100) / 100;

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
    price: round2(convert(price)),
    change: typeof prev === 'number' && prev !== 0 ? round2(((price - prev) / prev) * 100) : null,
  };
}

async function goldApi(symbol, convert = (p) => p) {
  const data = await getJson(`https://api.gold-api.com/price/${symbol}`);
  if (typeof data.price !== 'number') throw new Error(`no price from gold-api for ${symbol}`);
  return { price: round2(convert(data.price)), change: null };
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
  const price = values[values.length - 1];
  const prev = values.length > 1 ? values[values.length - 2] : null;
  return {
    price: round2(price),
    change: prev ? round2(((price - prev) / prev) * 100) : null,
  };
}

const SYMBOLS = {
  gold:      { primary: () => yahoo('GC=F'),  fallback: () => goldApi('XAU') },
  silver:    { primary: () => yahoo('SI=F'),  fallback: () => goldApi('XAG') },
  copper:    { primary: () => yahoo('HG=F', (p) => p * LB_PER_TONNE), fallback: () => goldApi('HG', (p) => p * LB_PER_TONNE) },
  aluminium: { primary: () => yahoo('ALI=F'), fallback: () => fred('PALUMUSDM') },
  brent:     { primary: () => yahoo('BZ=F'),  fallback: () => fred('DCOILBRENTEU') },
};

let previous = {};
try {
  previous = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  // first run, or file missing — changes fall back to 0
}

const out = { updatedAt: new Date().toISOString() };
let failures = 0;

for (const [key, { primary, fallback }] of Object.entries(SYMBOLS)) {
  let entry;
  try {
    entry = await primary();
  } catch (ePrimary) {
    try {
      entry = await fallback();
      console.warn(`[${key}] primary failed (${ePrimary.message}), used fallback`);
    } catch (eFallback) {
      console.error(`[${key}] all sources failed: ${eFallback.message}`);
      failures++;
      if (previous[key]) out[key] = previous[key]; // keep last known values
      continue;
    }
  }
  if (entry.change === null) {
    const prevPrice = previous[key]?.price;
    entry.change = prevPrice ? round2(((entry.price - prevPrice) / prevPrice) * 100) : 0;
  }
  out[key] = entry;
}

if (failures === Object.keys(SYMBOLS).length) {
  console.error('every symbol failed; leaving api/prices untouched');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}:`);
console.log(JSON.stringify(out, null, 2));
