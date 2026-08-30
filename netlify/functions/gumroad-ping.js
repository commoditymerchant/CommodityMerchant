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

exports.handler = async (event) => {
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
