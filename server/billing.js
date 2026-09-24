// NexLaunch billing: Stripe Checkout + webhook.
//
// Zero-dependency: the Stripe REST API over global fetch, and node:crypto for
// webhook signature verification. No `stripe` package to install or pin.
//
// CARD DATA NEVER TOUCHES THIS SERVER. We create a Checkout Session and send
// the customer to Stripe's own hosted page; they type their card on stripe.com.
// That is what keeps this out of PCI scope, and it is the reason there is no
// card field anywhere in this codebase. Do not add one.
//
// The flow:
//   1. Browser (logged in) POSTs /api/billing/checkout {plan}
//   2. We create a Checkout Session against the price id for that plan
//   3. Browser is redirected to session.url on stripe.com
//   4. Stripe POSTs /api/billing/webhook when payment completes
//   5. We verify the signature, then set the plan on the account
//
// Step 5 is the only thing that grants a paid plan. The success redirect is a
// courtesy for the customer's eyes: it proves nothing, arrives before the
// webhook sometimes, and can be visited by anyone who guesses the URL.
'use strict';

const crypto = require('node:crypto');
const accounts = require('./accounts');

const STRIPE_API = 'https://api.stripe.com/v1';

// Plan → Stripe price id. Set these in server/.env once the products exist in
// the Stripe dashboard; until then checkout returns a clear "not configured".
function priceIds(env) {
  return {
    starter: env.STRIPE_PRICE_STARTER || '',
    growth: env.STRIPE_PRICE_GROWTH || '',
    scale: env.STRIPE_PRICE_SCALE || '',
  };
}

function isConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Stripe wants form encoding, including for nested fields. */
function form(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

async function stripeCall(env, endpoint, params) {
  const res = await fetch(`${STRIPE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `stripe ${res.status}`;
    return { error: msg, status: res.status };
  }
  return { body };
}

/**
 * Create a Checkout Session for a logged-in user.
 *
 * The email is taken from the SESSION, never from the request body. Letting the
 * browser name the account to upgrade would mean anyone could pay $29 and
 * upgrade someone else - or, more usefully to an attacker, claim a plan bought
 * with a stolen card against an account they control.
 */
async function createCheckout(env, { user, plan, origin }) {
  if (!isConfigured(env)) {
    return { error: 'billing is not configured on this server (STRIPE_SECRET_KEY missing)' };
  }
  const prices = priceIds(env);
  const price = prices[plan];
  if (!price) {
    return { error: `no Stripe price configured for plan "${plan}"` };
  }

  const site = env.NEXLAUNCH_SITE_URL || origin || '';
  const result = await stripeCall(env, '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': 1,
    customer_email: user.email,
    client_reference_id: user.email,
    // Carried through to the webhook, so the plan granted is the plan bought
    // rather than something re-derived from the price id later.
    'metadata[email]': user.email,
    'metadata[plan]': plan,
    'subscription_data[metadata][email]': user.email,
    'subscription_data[metadata][plan]': plan,
    success_url: `${site}/app.html?checkout=success`,
    cancel_url: `${site}/index.html?checkout=cancelled`,
  });
  if (result.error) return { error: result.error };
  return { url: result.body.url, id: result.body.id };
}

/**
 * Verify Stripe's webhook signature.
 *
 * Without this, the webhook is an unauthenticated endpoint that grants paid
 * plans to anyone who can POST JSON at it - a one-line curl for a free "scale"
 * account. The signature is over "<timestamp>.<raw body>", so the RAW bytes are
 * required: parsing the JSON first and re-stringifying it changes the bytes and
 * every signature fails.
 */
function verifyWebhook(env, rawBody, signatureHeader, toleranceSeconds = 300) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: 'STRIPE_WEBHOOK_SECRET not set' };

  const parts = String(signatureHeader || '').split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || !signatures.length) return { ok: false, error: 'malformed Stripe-Signature' };

  // Replay window. A captured webhook stays valid forever without this.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, error: 'webhook timestamp outside tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const match = signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!match) return { ok: false, error: 'signature mismatch' };

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch {
    return { ok: false, error: 'webhook body was not JSON' };
  }
}

/**
 * Apply a verified event to an account.
 *
 * Only a handful of events matter. Everything else is acknowledged and ignored:
 * returning non-200 to Stripe for events we simply do not care about makes it
 * retry them for days and buries the ones that do matter.
 */
function applyEvent(event) {
  const type = event?.type;
  const object = event?.data?.object || {};

  if (type === 'checkout.session.completed') {
    const email = object.metadata?.email || object.client_reference_id || object.customer_email;
    const plan = object.metadata?.plan;
    if (!email || !plan) return { ignored: true, reason: 'no email/plan in session metadata' };
    const paid = object.payment_status === 'paid' || object.status === 'complete';
    if (!paid) return { ignored: true, reason: `payment_status=${object.payment_status}` };
    return {
      applied: accounts.setPlan(email, {
        plan,
        status: 'active',
        stripeCustomerId: object.customer || null,
      }),
      email,
      plan,
    };
  }

  // The subscription ending is the one that must never be missed: a lapsed
  // customer keeping a paid dashboard is revenue quietly leaking.
  if (type === 'customer.subscription.deleted') {
    const email = object.metadata?.email;
    if (!email) return { ignored: true, reason: 'no email in subscription metadata' };
    return { applied: accounts.setPlan(email, { plan: 'free', status: 'cancelled' }), email, plan: 'free' };
  }

  if (type === 'invoice.payment_failed') {
    const email = object.subscription_details?.metadata?.email || object.customer_email;
    if (!email) return { ignored: true, reason: 'no email on failed invoice' };
    // Flag it, do not downgrade - Stripe retries, and most of these recover.
    return { applied: accounts.setPlan(email, { status: 'past_due' }), email };
  }

  return { ignored: true, reason: `unhandled event ${type}` };
}

module.exports = { createCheckout, verifyWebhook, applyEvent, isConfigured, priceIds };
