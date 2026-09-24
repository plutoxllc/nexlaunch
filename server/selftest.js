// NexLaunch server selftest — accounts, sessions, plans, Stripe webhook.
//
//   node server/selftest.js
//
// Zero-dependency, like the server. Runs against a throwaway data directory so
// it can never touch real accounts: NEXLAUNCH_DATA_DIR is set before anything
// is required, and the suite refuses to run if it points anywhere real.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// MUST happen before requiring accounts.js — it reads the dir at module load.
const SANDBOX = path.join(os.tmpdir(), `nexlaunch-selftest-${process.pid}`);
process.env.NEXLAUNCH_DATA_DIR = SANDBOX;
if (!/selftest/.test(process.env.NEXLAUNCH_DATA_DIR)) {
  console.error('refusing to run: NEXLAUNCH_DATA_DIR is not a sandbox');
  process.exit(1);
}

const accounts = require('./accounts');
const billing = require('./billing');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log(`  ok    ${name}`))
       : (fail++, console.log(`  FAIL  ${name} ${extra}`));
};
const reset = () => fs.rmSync(SANDBOX, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\nsignup');
reset();
{
  const out = accounts.signup({ email: 'Jay@Example.com ', password: 'a-good-long-password', name: 'Jay' });
  check('creates an account', Boolean(out.token && out.user));
  check('email is normalised', out.user?.email === 'jay@example.com');
  check('starts on the free plan', out.user?.plan === 'free');
  check('never returns the password hash', !JSON.stringify(out).includes('scrypt$'));

  const dup = accounts.signup({ email: 'jay@example.com', password: 'another-long-password' });
  check('refuses a duplicate email', Boolean(dup.error));

  check('refuses a short password', Boolean(accounts.signup({ email: 'a@b.co', password: 'short' }).error));
  check('refuses an all-digit password', Boolean(accounts.signup({ email: 'a@b.co', password: '1234567890123' }).error));
  check('refuses a malformed email', Boolean(accounts.signup({ email: 'not-an-email', password: 'a-good-long-password' }).error));
}

// ---------------------------------------------------------------------------
console.log('\npasswords are never stored in the clear');
{
  const raw = accounts.rawUser('jay@example.com');
  check('the plaintext is absent from the record', !JSON.stringify(raw).includes('a-good-long-password'));
  check('the hash is scrypt', String(raw?.passwordHash || '').startsWith('scrypt$'));
  check('the hash verifies', accounts.verifyPassword('a-good-long-password', raw.passwordHash));
  check('a wrong password does not', !accounts.verifyPassword('a-good-long-passworD', raw.passwordHash));
  check('a garbage hash does not throw', accounts.verifyPassword('x', 'nonsense') === false);
  // Two accounts with the SAME password must not share a hash, or the file
  // leaks which users chose the same one.
  accounts.signup({ email: 'twin1@example.com', password: 'identical-password-here' });
  accounts.signup({ email: 'twin2@example.com', password: 'identical-password-here' });
  check('identical passwords hash differently (per-user salt)',
    accounts.rawUser('twin1@example.com').passwordHash !== accounts.rawUser('twin2@example.com').passwordHash);
}

// ---------------------------------------------------------------------------
console.log('\nlogin and sessions');
{
  const good = accounts.login({ email: 'jay@example.com', password: 'a-good-long-password' });
  check('correct password signs in', Boolean(good.token));

  const bad = accounts.login({ email: 'jay@example.com', password: 'wrong-password-here' });
  check('wrong password is refused', Boolean(bad.error));

  const missing = accounts.login({ email: 'nobody@example.com', password: 'wrong-password-here' });
  check('an unknown email is refused', Boolean(missing.error));
  check('...with the SAME message, so accounts cannot be enumerated',
    missing.error === bad.error);

  check('a session token resolves to the user',
    accounts.userForToken(good.token)?.email === 'jay@example.com');
  check('a made-up token resolves to nobody',
    accounts.userForToken(crypto.randomBytes(32).toString('hex')) === null);
  check('an empty token resolves to nobody', accounts.userForToken('') === null);

  // The stored session must not BE the token.
  const db = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'accounts.json'), 'utf8'));
  check('the raw token is not stored on disk', !JSON.stringify(db.sessions).includes(good.token));

  accounts.logout(good.token);
  check('logout invalidates the token', accounts.userForToken(good.token) === null);
}

// ---------------------------------------------------------------------------
console.log('\nplans are granted by the server, never claimed by the browser');
{
  const before = accounts.userForToken(accounts.login({ email: 'jay@example.com', password: 'a-good-long-password' }).token);
  check('a new account is not paid', before.plan === 'free');

  accounts.setPlan('jay@example.com', { plan: 'growth', status: 'active' });
  const after = accounts.rawUser('jay@example.com');
  check('setPlan upgrades', after.plan === 'growth');
  check('and records the status', after.planStatus === 'active');
  check('an unknown plan is refused', Boolean(accounts.setPlan('jay@example.com', { plan: 'enterprise' }).error));
  check('setting a plan on a missing account is refused',
    Boolean(accounts.setPlan('ghost@example.com', { plan: 'scale' }).error));

  // There is deliberately no route to this from the browser; the closest thing
  // is the signup body, which must not be able to smuggle a plan in.
  const sneaky = accounts.signup({ email: 'sneak@example.com', password: 'a-good-long-password', plan: 'scale' });
  check('signup cannot smuggle a paid plan', sneaky.user?.plan === 'free');
}

// ---------------------------------------------------------------------------
console.log('\nstripe webhook signature');
{
  const SECRET = 'whsec_test_secret';
  const env = { STRIPE_WEBHOOK_SECRET: SECRET };
  const body = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { payment_status: 'paid', metadata: { email: 'jay@example.com', plan: 'scale' }, customer: 'cus_123' } },
  });
  const sign = (raw, secret, ts) =>
    `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex')}`;

  const now = Math.floor(Date.now() / 1000);

  check('a correctly signed webhook is accepted',
    verifyOk(billing.verifyWebhook(env, body, sign(body, SECRET, now))));

  // THE hole this closes: without verification, anyone who can POST JSON at
  // this endpoint grants themselves a paid plan with one curl.
  check('an UNSIGNED webhook is rejected',
    !verifyOk(billing.verifyWebhook(env, body, '')));
  check('a wrong-secret signature is rejected',
    !verifyOk(billing.verifyWebhook(env, body, sign(body, 'whsec_attacker', now))));
  check('a tampered body is rejected',
    !verifyOk(billing.verifyWebhook(env, body.replace('scale', 'free'), sign(body, SECRET, now))));
  check('an old webhook is rejected (replay)',
    !verifyOk(billing.verifyWebhook(env, body, sign(body, SECRET, now - 4000))));
  check('a future-dated webhook is rejected',
    !verifyOk(billing.verifyWebhook(env, body, sign(body, SECRET, now + 4000))));
  check('a malformed signature header is rejected',
    !verifyOk(billing.verifyWebhook(env, body, 'garbage')));
  check('no configured secret means rejected, not open',
    !verifyOk(billing.verifyWebhook({}, body, sign(body, SECRET, now))));

  function verifyOk(v) { return v && v.ok === true; }
}

// ---------------------------------------------------------------------------
console.log('\nwebhook effects');
{
  const paid = {
    type: 'checkout.session.completed',
    data: { object: { payment_status: 'paid', metadata: { email: 'jay@example.com', plan: 'starter' }, customer: 'cus_abc' } },
  };
  billing.applyEvent(paid);
  check('a completed checkout grants the plan', accounts.rawUser('jay@example.com').plan === 'starter');
  check('and records the Stripe customer', accounts.rawUser('jay@example.com').stripeCustomerId === 'cus_abc');

  // An unpaid session must not grant anything - Stripe sends these.
  accounts.setPlan('jay@example.com', { plan: 'free' });
  billing.applyEvent({
    type: 'checkout.session.completed',
    data: { object: { payment_status: 'unpaid', metadata: { email: 'jay@example.com', plan: 'scale' } } },
  });
  check('an UNPAID checkout grants nothing', accounts.rawUser('jay@example.com').plan === 'free');

  // Cancellation is the one that leaks money if missed.
  accounts.setPlan('jay@example.com', { plan: 'scale', status: 'active' });
  billing.applyEvent({
    type: 'customer.subscription.deleted',
    data: { object: { metadata: { email: 'jay@example.com' } } },
  });
  check('a cancelled subscription drops to free', accounts.rawUser('jay@example.com').plan === 'free');

  // A failed payment should flag, not immediately cut off - Stripe retries.
  accounts.setPlan('jay@example.com', { plan: 'growth', status: 'active' });
  billing.applyEvent({
    type: 'invoice.payment_failed',
    data: { object: { customer_email: 'jay@example.com' } },
  });
  const pastDue = accounts.rawUser('jay@example.com');
  check('a failed payment marks past_due', pastDue.planStatus === 'past_due');
  check('...but does not downgrade yet', pastDue.plan === 'growth');

  check('an unrelated event is ignored, not an error',
    billing.applyEvent({ type: 'customer.created', data: { object: {} } }).ignored === true);
}

// ---------------------------------------------------------------------------
console.log('\ncheckout refuses to run half-configured');
{
  (async () => {
    const noKey = await billing.createCheckout({}, { user: { email: 'a@b.co' }, plan: 'growth' });
    check('no Stripe key -> a clear error, not a crash', /not configured/i.test(noKey.error || ''));

    const noPrice = await billing.createCheckout(
      { STRIPE_SECRET_KEY: 'sk_test_x' },
      { user: { email: 'a@b.co' }, plan: 'growth' });
    check('no price id for the plan -> a clear error', /no Stripe price/i.test(noPrice.error || ''));

    reset();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })();
}
