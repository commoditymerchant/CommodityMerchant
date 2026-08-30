'use strict';

/**
 * Gumroad Ping -> Meta Conversions API bridge.
 *
 * PHASE 1: DIAGNOSTIC. This version does not talk to Meta at all. It parses the
 * incoming Ping body, logs a *redacted* description of what arrived, and
 * returns 200. The mapping is written in phase 2, against the field names this
 * actually observes, because Gumroad's Ping payload has changed over time and
 * the published docs lag behind it. Guessing field names here would produce a
 * bridge that looks healthy and silently sends nothing.
 *
 * Why the site needs this at all: Gumroad's browser pixel fires ViewContent to
 * 28202509606034754 but never fires Purchase. That was confirmed on 30 Aug 2026
 * across three completed orders, one of them desktop Chrome with no ad blocker
 * and no errors in Meta Diagnostics. So this is a replacement for browser-side
 * purchase tracking, not a repair of it.
 *
 * Logging rule, which holds in every version of this file: the buyer's email
 * address is never written to a log line. Not truncated, not "just the domain".
 * Redaction here is deliberately belt-and-braces - it redacts on the key name
 * AND on the value's shape - so that an email arriving under a field name we
 * did not anticipate still does not leak.
 */

const crypto = require('node:crypto');

// Keys whose values must never be sampled into a log line.
const SENSITIVE_KEY =
  /(email|e_?mail|buyer|purchaser|full_?name|first_?name|last_?name|address|street|city|zip|postal|phone|card|licence|license|ip_address|fbclid|fbc|fbp|gclid)/i;

// A value that looks like an email is redacted no matter what it is called.
// This is the half that protects against a field name we have not seen before.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Describe one field without disclosing it.
 *
 * Sensitive fields report only their length and a 12-character hash prefix -
 * enough to confirm the field arrived and to tell two different values apart
 * across pings, and not enough to recover the value.
 */
function describe(key, value) {
  const len = value.length;
  if (SENSITIVE_KEY.test(key) || EMAIL_RE.test(value)) {
    return { len, redacted: true, sha12: sha256Hex(value).slice(0, 12) };
  }
  const sample = len > 96 ? value.slice(0, 96) + '…' : value;
  return { len, sample };
}

/** Form-encoded is what Gumroad sends; JSON is accepted so a hand-made curl works too. */
function parseBody(rawBody, contentType) {
  const params = new URLSearchParams();
  if (/application\/json/i.test(contentType || '')) {
    const parsed = JSON.parse(rawBody);
    for (const [k, v] of Object.entries(parsed)) {
      params.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return { params, format: 'json' };
  }
  for (const [k, v] of new URLSearchParams(rawBody)) params.append(k, v);
  return { params, format: 'form' };
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
  let format;
  try {
    ({ params, format } = parseBody(rawBody, contentType));
  } catch (err) {
    console.log('[gumroad-ping] unparseable body', {
      contentType,
      bodyLength: rawBody.length,
      error: err.message,
    });
    // Still 200. A non-200 makes Gumroad retry, and a retry of a body we
    // cannot parse just produces the same failure twice.
    return { statusCode: 200, body: 'ok' };
  }

  // Duplicate keys are collapsed for the shape report but counted, because
  // Gumroad sends repeated keys for some list-valued fields.
  const keys = [...params.keys()];
  const shape = {};
  for (const key of new Set(keys)) {
    const values = params.getAll(key);
    shape[key] = values.length === 1
      ? describe(key, values[0])
      : { repeated: values.length, first: describe(key, values[0]) };
  }

  // The seller gate is only *reported* in this phase, never enforced. Enforcing
  // it before we have seen a real ping risks rejecting the very payload we are
  // trying to read - and then the log says nothing at all.
  const expectedSeller = process.env.GUMROAD_SELLER_ID;
  const seenSeller = params.get('seller_id');
  let sellerCheck;
  if (!expectedSeller) sellerCheck = 'GUMROAD_SELLER_ID not set';
  else if (!seenSeller) sellerCheck = 'no seller_id in payload';
  else sellerCheck = seenSeller === expectedSeller ? 'MATCH' : 'MISMATCH';

  console.log(
    '[gumroad-ping] PHASE1 diagnostic\n' +
      JSON.stringify(
        {
          receivedAt: new Date().toISOString(),
          contentType,
          format,
          bodyLength: rawBody.length,
          keyCount: keys.length,
          sellerCheck,
          // Verbatim key list. This is the line that reveals nested names such
          // as url_params[fbclid], which decide whether ad-click attribution
          // is possible at all.
          keys: [...new Set(keys)].sort(),
          shape,
        },
        null,
        2
      )
  );

  return { statusCode: 200, body: 'ok' };
};
