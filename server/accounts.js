// NexLaunch accounts: signup, login, sessions, plan.
//
// Zero-dependency like the rest of this server — node:crypto has everything
// needed, so there is no bcrypt/jsonwebtoken to install or keep patched.
//
// What this replaces: the whole "account" was a JSON blob in localStorage that
// the browser wrote itself (js/landing.js). Anyone could open devtools, set
// nexlaunch_account to {"plan":"scale"}, and have the paid dashboard. There was
// no server-side user at all, so there was nothing to charge and nothing to
// protect.
//
// SECURITY NOTES, because these are the parts that are painful to fix later:
//   - Passwords are scrypt-hashed with a per-user random salt. The plaintext is
//     never written to disk or logged, and never leaves this module.
//   - Password and token comparisons are timing-safe.
//   - Session tokens are random 32-byte values. Only their SHA-256 hash is
//     stored, so a leaked accounts.json cannot be replayed as a login.
//   - The plan lives on the server record, set only by the Stripe webhook.
//     The browser can ask what its plan is; it can never assert one.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.NEXLAUNCH_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// Plans must match the pricing table on the landing page. `free` is what a new
// signup gets; everything else is granted by Stripe and nothing else.
const PLANS = ['free', 'starter', 'growth', 'scale'];

// ---------------------------------------------------------------------------
// Storage. A JSON file is the right size for this: the server is a single
// process on one box, and an early SaaS has tens of users, not millions.
// Swapping in SQLite later touches only this section.
// ---------------------------------------------------------------------------
function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!db || typeof db !== 'object') return { users: {}, sessions: {} };
    return { users: db.users || {}, sessions: db.sessions || {} };
  } catch {
    return { users: {}, sessions: {} };
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate the user table.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  } catch {
    return false;
  }
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // throw here would read as "server error" instead of "wrong password".
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Sessions. The token goes to the browser once; we keep only its hash.
// ---------------------------------------------------------------------------
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function issueSession(db, email) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[hashToken(token)] = {
    email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(),
  };
  return token;
}

function pruneSessions(db) {
  const now = Date.now();
  for (const [key, s] of Object.entries(db.sessions)) {
    if (!s?.expiresAt || new Date(s.expiresAt).getTime() < now) delete db.sessions[key];
  }
}

// ---------------------------------------------------------------------------
// What the browser is allowed to see. Never the hash, never the Stripe ids.
// ---------------------------------------------------------------------------
function publicUser(user) {
  if (!user) return null;
  return {
    email: user.email,
    name: user.name || null,
    plan: user.plan || 'free',
    planStatus: user.planStatus || 'none',
    createdAt: user.createdAt,
    trialEndsAt: user.trialEndsAt || null,
  };
}

const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

// A deliberately mild rule. Length is what actually matters, and a thicket of
// character-class requirements pushes people to "Password1!" and a sticky note.
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'password must be at least 10 characters';
  if (p.length > 200) return 'password is too long';
  if (/^\d+$/.test(p)) return 'password cannot be only numbers';
  return null;
}

function emailProblem(email) {
  const e = normaliseEmail(email);
  if (!e) return 'email is required';
  if (e.length > 200) return 'email is too long';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'that email does not look right';
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function signup({ email, password, name }) {
  const emailErr = emailProblem(email);
  if (emailErr) return { error: emailErr };
  const pwErr = passwordProblem(password);
  if (pwErr) return { error: pwErr };

  const db = load();
  const key = normaliseEmail(email);
  if (db.users[key]) return { error: 'an account with that email already exists' };

  db.users[key] = {
    email: key,
    name: String(name || '').trim().slice(0, 80) || null,
    passwordHash: hashPassword(password),
    plan: 'free',
    planStatus: 'none',
    createdAt: new Date().toISOString(),
    stripeCustomerId: null,
  };
  const token = issueSession(db, key);
  pruneSessions(db);
  save(db);
  return { token, user: publicUser(db.users[key]) };
}

function login({ email, password }) {
  const db = load();
  const key = normaliseEmail(email);
  const user = db.users[key];

  // Same message and roughly the same work either way, so the response cannot
  // be used to enumerate which emails have accounts.
  const ok = user
    ? verifyPassword(password, user.passwordHash)
    : (crypto.scryptSync(String(password || ''), 'decoy', SCRYPT_KEYLEN), false);
  if (!ok) return { error: 'email or password is incorrect' };

  const token = issueSession(db, key);
  pruneSessions(db);
  save(db);
  return { token, user: publicUser(user) };
}

function userForToken(token) {
  if (!token) return null;
  const db = load();
  const session = db.sessions[hashToken(token)];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return publicUser(db.users[session.email]);
}

function logout(token) {
  if (!token) return false;
  const db = load();
  const key = hashToken(token);
  if (!db.sessions[key]) return false;
  delete db.sessions[key];
  save(db);
  return true;
}

/**
 * Set a plan. Called by the Stripe webhook and by nothing else — the browser
 * has no route that reaches this, which is the entire point of moving accounts
 * off localStorage.
 */
function setPlan(email, { plan, status, stripeCustomerId }) {
  const key = normaliseEmail(email);
  if (plan && !PLANS.includes(plan)) return { error: `unknown plan: ${plan}` };
  const db = load();
  const user = db.users[key];
  if (!user) return { error: 'no such account' };
  if (plan) user.plan = plan;
  if (status) user.planStatus = status;
  if (stripeCustomerId) user.stripeCustomerId = stripeCustomerId;
  user.planUpdatedAt = new Date().toISOString();
  save(db);
  return { user: publicUser(user) };
}

function rawUser(email) {
  return load().users[normaliseEmail(email)] || null;
}

function stats() {
  const db = load();
  const users = Object.values(db.users);
  const byPlan = {};
  for (const u of users) byPlan[u.plan || 'free'] = (byPlan[u.plan || 'free'] || 0) + 1;
  return { users: users.length, sessions: Object.keys(db.sessions).length, byPlan };
}

module.exports = {
  PLANS,
  signup,
  login,
  logout,
  userForToken,
  setPlan,
  rawUser,
  stats,
  publicUser,
  // exported for tests
  hashPassword,
  verifyPassword,
  passwordProblem,
  emailProblem,
};
