'use strict';

/**
 * Gumroad Ping -> Meta Conversions API bridge.
 *
 * Why this exists: Gumroad's browser pixel fires ViewContent to 28202509606034754
 * but never fires Purchase. Confirmed 30 Aug 2026 across three completed orders,
 * one of them desktop Chrome with no ad blocker and no Meta Diagnostics errors.
 * This replaces browser-side purchase tracking rather than repairing it.
 *
 * PHASE 2. The mapping below is written against three real payloads captured by
 * the phase-1 diagnostic on 30 Aug 2026 - two Gumroad test pings and one genuine
 * $0 sample order - not against the documented field list, which was wrong in
 * three places that would each have failed silently:
 *
 *   * `product_permalink` is the FULL URL (https://merchantmind5.gumroad.com/l/jsppcy).
 *     The bare slug lives in `permalink` and `short_product_id`.
 *   * `ip_country` is a country NAME ("Türkiye", "United Arab Emirates"), not a
 *     two-letter ISO code. Meta matches on hashed ISO-3166 alpha-2, so hashing
 *     the name would produce a hash that can never match anything.
 *   * `resource_name` is absent on test pings and present ("sale") on real ones;
 *     test pings instead carry `test: "true"`, which is what we gate on.
 *
 * Forwarding to Meta is behind a flag that stays off while META_CAPI_TOKEN is
 * unset. Token generation is blocked upstream: "Generate access token" is greyed
 * out in Events Manager because the profile driving developers.facebook.com
 * cannot see business portfolio 1197798223427741, so the receiver has to be
 * useful without it. It is: attribution runs on the ?src= and ?ad= tags that
 * arrive in url_params and are logged here, which needs no token at all.
 *
 * Logging rule, unchanged from phase 1: the buyer's email is never written to a
 * log line. Redaction triggers on both the key name and the value's shape, so an
 * email arriving under a field name we have not seen still does not leak.
 */

const crypto = require('node:crypto');

const META_PIXEL_ID = '28202509606034754';
const META_API_VERSION = 'v21.0';

/**
 * A £0/$0 download is a lead magnet, not a sale. Reporting it as a Purchase of
 * value 0 would drag reported CPA toward zero and make the paid campaign look
 * far better than it is - the same class of silent corruption as getting minor
 * units wrong. Free downloads therefore map to Lead. Set this to false to send
 * everything as Purchase.
 */
const FREE_ORDERS_ARE_LEADS = true;

// Currencies with no minor unit: the integer Gumroad sends is already the whole
// amount, so dividing by 100 would under-report the sale by 100x.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Gumroad sends a display name; Meta wants ISO-3166 alpha-2, lowercased, then
 * hashed. Anything not listed here is omitted rather than guessed - a wrong
 * country hash is worse than an absent one, because it silently fails to match
 * while looking like a populated field.
 */
const COUNTRY_ISO = {
  'united arab emirates': 'ae', 'türkiye': 'tr', 'turkiye': 'tr', 'turkey': 'tr',
  'united kingdom': 'gb', 'united states': 'us', 'usa': 'us', 'canada': 'ca',
  'australia': 'au', 'india': 'in', 'germany': 'de', 'france': 'fr',
  'netherlands': 'nl', 'spain': 'es', 'italy': 'it', 'ireland': 'ie',
  'singapore': 'sg', 'switzerland': 'ch', 'sweden': 'se', 'norway': 'no',
  'denmark': 'dk', 'finland': 'fi', 'belgium': 'be', 'austria': 'at',
  'poland': 'pl', 'portugal': 'pt', 'greece': 'gr', 'brazil': 'br',
  'mexico': 'mx', 'argentina': 'ar', 'south africa': 'za', 'nigeria': 'ng',
  'kenya': 'ke', 'egypt': 'eg', 'saudi arabia': 'sa', 'qatar': 'qa',
  'kuwait': 'kw', 'bahrain': 'bh', 'oman': 'om', 'japan': 'jp',
  'china': 'cn', 'hong kong': 'hk', 'south korea': 'kr', 'indonesia': 'id',
  'malaysia': 'my', 'philippines': 'ph', 'thailand': 'th', 'vietnam': 'vn',
  'new zealand': 'nz', 'israel': 'il', 'pakistan': 'pk', 'bangladesh': 'bd',
  'ukraine': 'ua', 'romania': 'ro', 'czechia': 'cz', 'czech republic': 'cz',
  'hungary': 'hu', 'chile': 'cl', 'colombia': 'co', 'peru': 'pe',
};

const SENSITIVE_KEY =
  /(email|e_?mail|buyer|purchaser|full_?name|first_?name|last_?name|address|street|city|zip|postal|phone|card|licence|license|ip_address|fbclid|fbc|fbp|gclid)/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function describe(key, value) {
  const len = value.length;
  if (SENSITIVE_KEY.test(key) || EMAIL_RE.test(value)) {
    return { len, redacted: true, sha12: sha256Hex(value).slice(0, 12) };
  }
  return { len, sample: len > 96 ? value.slice(0, 96) + '…' : value };
}

function parseBody(rawBody, contentType) {
  const params = new URLSearchParams();
  if (/application\/json/i.test(contentType || '')) {
    for (const [k, v] of Object.entries(JSON.parse(rawBody))) {
      params.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return { params, format: 'json' };
  }
  for (const [k, v] of new URLSearchParams(rawBody)) params.append(k, v);
  return { params, format: 'form' };
}

/** price is an integer in the currency's minor unit. See the caveat in the log. */
function toMajorUnits(rawPrice, currency) {
  const cents = Number.parseInt(rawPrice, 10);
  if (!Number.isFinite(cents)) return null;
  if (ZERO_DECIMAL.has((currency || '').toUpperCase())) return cents;
  return Number((cents / 100).toFixed(2));
}

function eventTimeSeconds(saleTimestamp) {
  const parsed = Date.parse(saleTimestamp || '');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(parsed)) return { seconds: now, source: 'now (unparseable sale_timestamp)' };
  const seconds = Math.floor(parsed / 1000);
  // Meta rejects events more than 7 days old or dated in the future.
  if (seconds > now + 60) return { seconds: now, source: 'now (sale_timestamp in future)' };
  if (seconds < now - 6 * 24 * 3600) return { seconds, source: 'sale_timestamp (older than 6d - Meta may reject)' };
  return { seconds, source: 'sale_timestamp' };
}

/* ---------------------------------------------------------------------------
 * Persistence.
 *
 * Until 5 Sep 2026 this function only ever called console.log, so the record of
 * every ping was a Netlify function log line. Netlify streams those live and
 * offers no historical query, no export and no retention without a log drain,
 * which means the campaign-1 pings could not be read back by anyone and are
 * now gone. Writing them to a blob store fixes that going forward; it cannot
 * recover what was never stored.
 *
 * The require is lazy and guarded on purpose. Both deploy paths - the 2-hourly
 * price cron and publish_site.py - run `npx netlify-cli deploy` against a tree
 * with no npm install, so a hard top-level require of a package that is not
 * there would break the bundle and take the Gumroad bridge down with it. If the
 * module is missing, storage degrades and POST is completely unaffected.
 */
const PING_STORE = 'gumroad-pings';
let blobsModule;

/**
 * Open the store, or explain precisely why it cannot be opened.
 *
 * Returns { store, error } and never throws. The error string is surfaced -
 * GET returns 500 carrying it, and POST logs it under a marker that is meant
 * to be searched for. It is deliberately not swallowed into a null store,
 * because "storage quietly off" is the exact bug this whole change exists to
 * end: on 5 Sep 2026 the first version of this shipped, passed its tests, and
 * stored nothing at all, because the tests replaced this module with a mock
 * and so never once constructed a real store.
 *
 * Why explicit credentials: Netlify injects NETLIFY_BLOBS_CONTEXT only for
 * git-connected builds. This site is deployed with `netlify deploy --dir .`
 * from a laptop and from the price cron, which injects nothing, so the zero-arg
 * getStore() throws MissingBlobsEnvironmentError at runtime. Passing siteID and
 * token from environment variables is the form that actually works here.
 */
function openPingStore() {
  if (blobsModule === undefined) {
    try {
      blobsModule = require('@netlify/blobs');
    } catch (err) {
      blobsModule = null;
      return { store: null, error: `@netlify/blobs is not bundled with this deploy: ${err.message}` };
    }
  }
  if (!blobsModule) {
    return { store: null, error: '@netlify/blobs is not bundled with this deploy' };
  }

  const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || '';

  try {
    if (siteID && token) {
      return { store: blobsModule.getStore({ name: PING_STORE, siteID, token }), error: null };
    }
    // A git-connected build would give us this for free; keep supporting it so
    // the function does not break if the deploy method ever changes.
    if (process.env.NETLIFY_BLOBS_CONTEXT) {
      return { store: blobsModule.getStore(PING_STORE), error: null };
    }
    return {
      store: null,
      error:
        'Blobs is not configured for this deploy. Set BLOBS_SITE_ID and BLOBS_TOKEN ' +
        'in the Netlify site environment (this site deploys via `netlify deploy`, ' +
        'which does not inject NETLIFY_BLOBS_CONTEXT). ' +
        `Currently: siteID=${siteID ? 'set' : 'MISSING'}, token=${token ? 'set' : 'MISSING'}.`,
    };
  } catch (err) {
    return { store: null, error: `${err.name || 'Error'}: ${err.message}` };
  }
}

/** ISO first so plain lexicographic key order is chronological order. */
function pingKey(receivedAt, saleId) {
  const suffix = (saleId || 'nosale').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'nosale';
  return `${receivedAt}__${suffix}__${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Read stored pings newest first. Keys sort chronologically, so reverse order
 * is newest first and we can stop fetching as soon as the page is full rather
 * than pulling the whole store for a 20-row answer.
 */
async function loadPings(store, { limit, tag, scanCap }) {
  const listed = await store.list();
  const keys = (listed.blobs || []).map((b) => b.key).sort().reverse().slice(0, scanCap);

  const out = [];
  for (let i = 0; i < keys.length && out.length < limit; i += 20) {
    const batch = keys.slice(i, i + 20);
    const records = await Promise.all(
      batch.map((k) => store.get(k, { type: 'json' }).catch(() => null))
    );
    for (const rec of records) {
      if (!rec) continue;
      if (tag && rec.tag !== tag) continue;
      out.push(rec);
      if (out.length >= limit) break;
    }
  }
  return { records: out, scanned: keys.length, total: (listed.blobs || []).length };
}

async function loadAllPings(store, scanCap) {
  const listed = await store.list();
  const keys = (listed.blobs || []).map((b) => b.key).sort().reverse().slice(0, scanCap);
  const out = [];
  for (let i = 0; i < keys.length; i += 20) {
    const records = await Promise.all(
      keys.slice(i, i + 20).map((k) => store.get(k, { type: 'json' }).catch(() => null))
    );
    for (const rec of records) if (rec) out.push(rec);
  }
  return { records: out, total: (listed.blobs || []).length };
}

function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const json = (statusCode, payload) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(payload, null, 2),
});

/**
 * GET: read the log back.
 *
 * Auth is mandatory and fails closed. If PING_LOG_TOKEN is unset the endpoint
 * returns 503 rather than becoming readable by anyone, because the alternative
 * failure mode - an unset variable silently disabling the check - is the one
 * that actually happens.
 */
async function handleGet(event) {
  const expected = process.env.PING_LOG_TOKEN || '';
  if (!expected) {
    console.log('[gumroad-ping] GET refused: PING_LOG_TOKEN is not set');
    return json(503, { error: 'not configured', detail: 'PING_LOG_TOKEN is not set on this site.' });
  }

  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const q = event.queryStringParameters || {};
  const presented = bearer ? bearer[1].trim() : (q.key || '').trim();

  if (!presented || !constantTimeEqual(presented, expected)) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }

  const { store, error: storeError } = openPingStore();
  if (!store) {
    // 500, not 200-with-an-empty-list. Reporting "0 pings" when the truth is
    // "storage is broken" is the failure this endpoint exists to prevent.
    console.log('[gumroad-ping] STORAGE FAILURE (read)', { error: storeError });
    return json(500, { error: 'storage unavailable', detail: storeError });
  }

  const scanCap = 5000;

  // ?health=1 - prove the store can actually be written and read, rather than
  // inferring it from an empty list. Writes one throwaway key and deletes it.
  if (q.health === '1' || q.health === 'true') {
    const probe = `__health__/${new Date().toISOString()}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await store.setJSON(probe, { probe: true, at: new Date().toISOString() });
      const readBack = await store.get(probe, { type: 'json' });
      await store.delete(probe);
      const ok = Boolean(readBack && readBack.probe === true);
      return json(ok ? 200 : 500, {
        storage: ok ? 'ok' : 'write succeeded but read-back failed',
        store: PING_STORE,
        checked: ['write', 'read', 'delete'],
      });
    } catch (err) {
      console.log('[gumroad-ping] STORAGE FAILURE (health probe)', { error: err.message });
      return json(500, { storage: 'failing', detail: `${err.name || 'Error'}: ${err.message}` });
    }
  }

  try {
    if (q.summary === '1' || q.summary === 'true') {
      const { records, total } = await loadAllPings(store, scanCap);
      const byTag = {};
      let tests = 0;
      let testValue = 0;
      for (const r of records) {
        if (r.isTest) {
          tests += 1;
          testValue += Number(r.value) || 0;
          continue;
        }
        const key = r.tag || '(untagged)';
        byTag[key] = byTag[key] || { tag: key, count: 0, value: 0, currency: r.currency || null };
        byTag[key].count += 1;
        byTag[key].value = Number((byTag[key].value + (Number(r.value) || 0)).toFixed(2));
      }
      const tagRows = Object.values(byTag).sort((a, b) => b.value - a.value || b.count - a.count);
      return json(200, {
        generatedAt: new Date().toISOString(),
        storedPings: total,
        realSales: { count: tagRows.reduce((n, r) => n + r.count, 0), value: Number(tagRows.reduce((n, r) => n + r.value, 0).toFixed(2)) },
        excludedTestPings: { count: tests, value: Number(testValue.toFixed(2)), note: 'test:"true" or carrying an offer_code - not sales' },
        byTag: tagRows,
      });
    }

    const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || 100, 1), 1000);
    const tag = (q.tag || '').trim() || null;
    const { records, scanned, total } = await loadPings(store, { limit, tag, scanCap });
    return json(200, {
      generatedAt: new Date().toISOString(),
      storedPings: total,
      scanned,
      returned: records.length,
      limit,
      filter: tag ? { tag } : null,
      note: 'Newest first. Buyer emails are never stored - emailSha12 is a truncated SHA-256.',
      pings: records,
    });
  } catch (err) {
    console.log('[gumroad-ping] GET failed', { error: err.message });
    return json(500, { error: 'read failed', detail: err.message });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return handleGet(event);
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = event.headers || {};
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  let params;
  try {
    ({ params } = parseBody(rawBody, contentType));
  } catch (err) {
    console.log('[gumroad-ping] unparseable body', { contentType, bodyLength: rawBody.length, error: err.message });
    return { statusCode: 200, body: 'ok' };
  }

  const get = (k) => (params.get(k) || '').trim();

  // ---- sender verification -------------------------------------------------
  // Gumroad Ping carries no signature, so seller_id is the only gate there is.
  // Fail closed: a mismatch means someone other than Gumroad is posting here.
  const expectedSeller = process.env.GUMROAD_SELLER_ID || '';
  const seenSeller = get('seller_id');
  if (!expectedSeller) {
    console.log('[gumroad-ping] REJECTED: GUMROAD_SELLER_ID is not set');
    return { statusCode: 503, body: 'not configured' };
  }
  const a = Buffer.from(expectedSeller);
  const b = Buffer.from(seenSeller);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.log('[gumroad-ping] REJECTED: seller_id mismatch', { seenSha12: sha256Hex(seenSeller).slice(0, 12) });
    return { statusCode: 403, body: 'forbidden' };
  }

  // ---- attribution ---------------------------------------------------------
  // With CAPI blocked, these tags ARE the attribution. ?src= is site traffic and
  // ?ad= is paid traffic; they are deliberately separate namespaces so a sale
  // from the links hub can never be counted as a sale from an ad.
  const urlParams = {};
  for (const [k, v] of params) {
    const m = /^url_params\[(.+)\]$/.exec(k);
    if (m) urlParams[m[1]] = v;
  }
  const src = urlParams.src || null;
  const ad = urlParams.ad || null;
  const fbclid = urlParams.fbclid || null;

  const isTest = get('test') === 'true';
  const rawPrice = get('price');
  const currency = (get('currency') || 'usd').toUpperCase();
  const value = toMajorUnits(rawPrice, currency);
  const permalink = get('permalink') || get('short_product_id') || null;
  const { seconds: eventTime, source: timeSource } = eventTimeSeconds(get('sale_timestamp'));

  const isFree = value === 0;
  const eventName = isFree && FREE_ORDERS_ARE_LEADS ? 'Lead' : 'Purchase';

  const emailRaw = get('email');
  const countryName = get('ip_country');
  const countryIso = COUNTRY_ISO[countryName.toLowerCase()] || null;

  const userData = {};
  if (emailRaw) userData.em = [sha256Hex(emailRaw.trim().toLowerCase())];
  if (countryIso) userData.country = [sha256Hex(countryIso)];
  // fbc is what ties a sale to the specific ad that produced it. It only exists
  // when Meta appended fbclid to the landing URL and that survived into
  // url_params - i.e. on a genuine ad click. Absent on direct and organic visits.
  if (fbclid) userData.fbc = `fb.1.${eventTime * 1000}.${fbclid}`;

  const metaEvent = {
    event_name: eventName,
    event_time: eventTime,
    event_id: get('sale_id') || undefined,
    action_source: 'website',
    event_source_url: get('product_permalink') ||
      (permalink ? `https://merchantmind5.gumroad.com/l/${permalink}` : undefined),
    user_data: userData,
    custom_data: {
      currency,
      value,
      content_ids: permalink ? [permalink] : [],
      content_type: 'product',
      num_items: Number.parseInt(get('quantity'), 10) || 1,
    },
  };

  console.log(
    '[gumroad-ping] ' + (isTest ? 'TEST PING (not forwarded)' : eventName) + '\n' +
      JSON.stringify(
        {
          receivedAt: new Date().toISOString(),
          sale_id: get('sale_id'),
          order_number: get('order_number'),
          product: { permalink, name: get('product_name') },
          // Both forms are logged so the first PAID sale settles the minor-units
          // question the moment it lands, without needing another deploy.
          price: { raw: rawPrice, currency, interpretedAs: value, note: 'raw assumed minor units' },
          attribution: { src, ad, fbclid: fbclid ? 'present' : 'absent', referrer: get('referrer'), urlParamKeys: Object.keys(urlParams) },
          country: { sent: countryName, iso: countryIso || 'UNMAPPED - country omitted from user_data' },
          eventTimeSource: timeSource,
          emailSha12: emailRaw ? sha256Hex(emailRaw.trim().toLowerCase()).slice(0, 12) : null,
          test: isTest,
        },
        null,
        2
      )
  );

  // ---- persist, so the log can actually be read back -----------------------
  // A storage problem must never turn into a non-200, because Gumroad retries
  // non-200s and a retry can double-fire the conversion. So failures are caught
  // here - but they are LOUD, not silent. Every failure path logs
  // "STORAGE FAILURE ... PING NOT STORED" with the reason, and GET reports a
  // broken store as a 500 rather than as an empty list. The first version of
  // this caught the error and said nothing, so storage was off from the moment
  // it deployed and no sale revealed it.
  //
  // The stored record is the same redacted shape as the log line above - the
  // raw email is never written anywhere, only its truncated hash.
  const offerCode = get('offer_code') || null;
  try {
    const { store, error: storeError } = openPingStore();
    if (!store) {
      // Loud and greppable. The first version of this logged nothing useful
      // when the store could not be opened, so every ping since deploy was
      // dropped without a trace. Search Netlify function logs for
      // "STORAGE FAILURE" to find it.
      console.log('[gumroad-ping] STORAGE FAILURE (write) - PING NOT STORED', {
        sale_id: get('sale_id') || null,
        error: storeError,
      });
    } else {
      const receivedAt = new Date().toISOString();
      const record = {
        receivedAt,
        sale_id: get('sale_id') || null,
        order_number: get('order_number') || null,
        eventName,
        product: { permalink, name: get('product_name') || null },
        rawPrice,
        currency,
        value,
        tag: ad || src || null,
        src,
        ad,
        fbclid: fbclid ? 'present' : 'absent',
        referrer: get('referrer') || null,
        country: { sent: countryName || null, iso: countryIso },
        emailSha12: emailRaw ? sha256Hex(emailRaw.trim().toLowerCase()).slice(0, 12) : null,
        test: isTest,
        offer_code: offerCode,
        // A Gumroad test ping and a discounted "sale" made with a test offer
        // code are both synthetic. Either one counted as revenue would overstate
        // the campaign, so the summary excludes both.
        isTest: isTest || Boolean(offerCode),
      };
      await store.setJSON(pingKey(receivedAt, record.sale_id), record);
    }
  } catch (err) {
    console.log('[gumroad-ping] STORAGE FAILURE (write) - PING NOT STORED', {
      sale_id: get('sale_id') || null,
      error: `${err.name || 'Error'}: ${err.message}`,
    });
  }

  // ---- forward to Meta, if we ever get a token -----------------------------
  const token = process.env.META_CAPI_TOKEN;
  if (isTest) {
    // A Gumroad test ping is a synthetic sale with a fixed sale_id. Forwarding it
    // would put a fake conversion in the pixel that no refund or dedup removes.
    return { statusCode: 200, body: 'ok (test ping, not forwarded)' };
  }
  if (!token) {
    console.log('[gumroad-ping] CAPI forwarding OFF (META_CAPI_TOKEN unset) - event logged only');
    return { statusCode: 200, body: 'ok (logged, capi off)' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [metaEvent], access_token: token }),
      }
    );
    const text = await res.text();
    console.log('[gumroad-ping] CAPI response', { status: res.status, body: text.slice(0, 400) });
  } catch (err) {
    // Never fail the webhook on a downstream problem. A non-200 makes Gumroad
    // retry, and a retry can double-fire; event_id dedup covers the retries that
    // do get through, but the cheaper fix is to not provoke them.
    console.log('[gumroad-ping] CAPI call failed', { error: err.message });
  }

  return { statusCode: 200, body: 'ok' };
};
