// Paystack adapter for the payment gateway interface (see ./index.js).
// Docs: https://paystack.com/docs/api/transaction/
import crypto from 'node:crypto';
import env from '../../config/env.js';
import httpError from '../../utils/httpError.js';

const BASE_URL = 'https://api.paystack.co';

export const name = 'paystack';

async function call(method, path, body) {
  if (!env.paystack.secretKey) throw httpError(503, 'Online payment is not configured (PAYSTACK_SECRET_KEY missing)');
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${env.paystack.secretKey}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw httpError(502, 'Could not reach Paystack. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== true) {
    const err = httpError(502, `Paystack: ${json.message || `HTTP ${res.status}`}`);
    err.gatewayStatus = res.status;
    throw err;
  }
  return json.data;
}

/**
 * Start a transaction. amountMinor is in kobo.
 * Returns { authorizationUrl, accessCode, reference }.
 */
export async function initialize({ email, amountMinor, currency, reference, callbackUrl, metadata }) {
  const data = await call('POST', '/transaction/initialize', {
    email, amount: amountMinor, currency, reference, callback_url: callbackUrl, metadata,
  });
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
}

/**
 * Ask Paystack for the final state of a transaction.
 * Returns { status: 'success'|'failed'|'abandoned'|..., amountMinor, currency, reference, paidAt, raw }.
 * An unknown reference returns status 'not_found'.
 */
export async function verify(reference) {
  let data;
  try {
    data = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    if (err.gatewayStatus === 400 || err.gatewayStatus === 404) return { status: 'not_found', reference };
    throw err;
  }
  return {
    status: data.status,
    amountMinor: data.amount,
    currency: data.currency,
    reference: data.reference,
    paidAt: data.paid_at,
    raw: {
      id: data.id,
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      currency: data.currency,
      channel: data.channel,
      gateway_response: data.gateway_response,
      paid_at: data.paid_at,
      customer_email: data.customer?.email,
    },
  };
}

/** x-paystack-signature = HMAC-SHA512 of the raw request body with the secret key. */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !env.paystack.secretKey || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', env.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pull { event, reference } out of a webhook body. */
export function parseWebhook(body) {
  return { event: body?.event, reference: body?.data?.reference };
}
