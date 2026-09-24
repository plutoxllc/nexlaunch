// NexLaunch SP-API sandbox backend
// Zero-dependency Node 18+ server: node:http + global fetch only.
// Since Oct 2023 SP-API requires NO AWS SigV4 — only the LWA access token
// in the "x-amz-access-token" header. Do not add SigV4 signing here.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const accounts = require('./accounts');
const billing = require('./billing');

// ---------------------------------------------------------------------------
// Env loading: server/.env (KEY=VALUE lines, # comments) with process.env wins
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out; // no .env is fine
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(__dirname, '.env'));
function env(key, fallback) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
  return fallback;
}

const CONFIG = {
  clientId: env('SPAPI_CLIENT_ID'),
  clientSecret: env('SPAPI_CLIENT_SECRET'),
  refreshToken: env('SPAPI_REFRESH_TOKEN'),
  spapiBase: env('SPAPI_BASE', 'https://sandbox.sellingpartnerapi-na.amazon.com'),
  port: Number(env('PORT', '4879')),
  marketplaceId: env('MARKETPLACE_ID', 'ATVPDKIKX0DER'),
  // Optional bearer token. When set, /api/xray requires it — REQUIRED on any
  // internet-reachable host, or strangers can burn your SP-API quota.
  apiToken: env('NEXLAUNCH_API_TOKEN', ''),
  // Merged view of server/.env + process.env, for modules that take an env bag
  // rather than calling env() themselves (billing.js). Same precedence as
  // env() above: a real process.env value wins, an empty one does not.
  // Without this, Stripe keys written to server/.env - the documented place,
  // where the SP-API creds already live - would be invisible and billing would
  // report itself unconfigured with the keys sitting right there.
  env: {
    ...fileEnv,
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')
    ),
  },
};

function isConfigured() {
  return Boolean(CONFIG.clientId && CONFIG.clientSecret && CONFIG.refreshToken);
}

// ---------------------------------------------------------------------------
// LWA token exchange with cache (refresh ~60s before expiry)
// ---------------------------------------------------------------------------
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CONFIG.refreshToken,
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LWA token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: now + (Number(json.expires_in) || 3600) * 1000,
  };
  return tokenCache.accessToken;
}

// ---------------------------------------------------------------------------
// SP-API helper: attach LWA token, parse JSON, throw with status on failure
// ---------------------------------------------------------------------------
async function spapiFetch(pathAndQuery, options = {}) {
  const accessToken = await getAccessToken();
  const res = await fetch(CONFIG.spapiBase + pathAndQuery, {
    method: options.method || 'GET',
    headers: {
      'x-amz-access-token': accessToken,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(
      `SP-API ${options.method || 'GET'} ${pathAndQuery.split('?')[0]} failed (HTTP ${res.status})`
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Run a sub-call; on failure return { error, status } instead of throwing.
async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    const section = { error: err.message || String(err) };
    if (err.status) section.status = err.status;
    if (err.body) section.detail = err.body;
    return section;
  }
}

// The live Buy Box landed price ONLY (no lowest-offer fallback). Returns
// null when there is no buyable Buy Box — which is the case for every
// VARIATION_PARENT ASIN and any listing with TotalOfferCount 0.
function buyBoxPrice(offers) {
  if (!offers || offers.error) return null;
  const summary = offers.payload && offers.payload.Summary;
  if (!summary) return null;
  const bb = Array.isArray(summary.BuyBoxPrices) ? summary.BuyBoxPrices[0] : null;
  if (bb && bb.LandedPrice) {
    const amt = Number(bb.LandedPrice.Amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
  }
  return null;
}

// itemClassification from the catalog summary (e.g. BASE_PRODUCT,
// VARIATION_PARENT, VARIATION_CHILD). Returns null when unavailable.
function catalogClassification(catalog) {
  if (!catalog || catalog.error) return null;
  const summaries = catalog.summaries || (catalog.payload && catalog.payload.summaries);
  const s = Array.isArray(summaries) ? summaries[0] : null;
  return (s && s.itemClassification) || null;
}

// Pull a usable listing price out of the offers section: Buy Box landed
// price first, then the lowest offer. Returns null when the section errored
// or carries no prices (TotalOfferCount may legitimately be 0).
function offerPrice(offers) {
  if (!offers || offers.error) return null;
  const summary = offers.payload && offers.payload.Summary;
  if (!summary) return null;

  const bb = Array.isArray(summary.BuyBoxPrices) ? summary.BuyBoxPrices[0] : null;
  if (bb && bb.LandedPrice) {
    const amt = Number(bb.LandedPrice.Amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
  }

  const lo = Array.isArray(summary.LowestPrices) ? summary.LowestPrices[0] : null;
  if (lo) {
    let amt = NaN;
    if (lo.LandedPrice && lo.LandedPrice.Amount != null) amt = Number(lo.LandedPrice.Amount);
    else if (lo.ListingPrice && lo.ListingPrice.Amount != null) amt = Number(lo.ListingPrice.Amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleHealth() {
  return { status: 200, body: { ok: true, configured: isConfigured() } };
}

async function handleXray(query) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: {
        error: 'SP-API credentials not configured',
        hint: 'copy server/.env.example to server/.env and fill in your sandbox app client values',
      },
    };
  }
  const asin = (query.get('asin') || '').trim();
  if (!asin) {
    return { status: 400, body: { error: 'missing required query param: asin' } };
  }

  // Fulfillment mode: 'fba' (default, Amazon-fulfilled) or 'fbm'
  // (merchant-fulfilled / dropship). FBM drops IsAmazonFulfilled so the fees
  // estimate returns the referral fee (and any variable closing fee) but NO
  // FBAFees line — the seller pays their supplier's ship cost, unknown to us.
  const fulfillment = (query.get('fulfillment') || 'fba').toLowerCase() === 'fbm' ? 'fbm' : 'fba';

  const mkt = CONFIG.marketplaceId;
  const encAsin = encodeURIComponent(asin);

  // Catalog + offers first — the fees estimate needs a real listing price.
  const [catalog, offers] = await Promise.all([
    safeCall(() =>
      spapiFetch(
        `/catalog/2022-04-01/items/${encAsin}?marketplaceIds=${encodeURIComponent(mkt)}&includedData=attributes,salesRanks,summaries`
      )
    ),
    safeCall(() =>
      spapiFetch(
        `/products/pricing/v0/items/${encAsin}/offers?MarketplaceId=${encodeURIComponent(mkt)}&ItemCondition=New`
      )
    ),
  ]);

  // Fee-estimate price: Buy Box → lowest offer → ?price= override → 29.99
  const priceParam = Number.parseFloat(query.get('price') || '');
  const derivedPrice = offerPrice(offers);
  const explicitPrice = Number.isFinite(priceParam) && priceParam > 0 ? priceParam : null;
  const feesEstimatedAt = derivedPrice ?? explicitPrice ?? 29.99;

  // Explicit Buy Box truth so nobody mistakes a fee-anchor fallback for a
  // real market price. VARIATION_PARENT ASINs and any listing with no
  // buyable offer return NO live Buy Box — the fee number is meaningless
  // as a resale price. priceBasis names exactly where feesEstimatedAt came from.
  const itemClassification = catalogClassification(catalog);
  const buyBox = buyBoxPrice(offers);
  const hasLiveBuyBox = buyBox !== null;
  const priceBasis = buyBox !== null ? 'live-buybox'
    : derivedPrice !== null ? 'lowest-offer'
    : explicitPrice !== null ? 'query-param'
    : 'fee-anchor-fallback';
  const priceWarning = hasLiveBuyBox ? null
    : itemClassification === 'VARIATION_PARENT'
      ? 'No live Buy Box: this is a variation-parent ASIN. Fees are anchored to a fallback price, not a real market price — use a specific child ASIN.'
      : 'No live Buy Box: no buyable offer found. Fees are anchored to a fallback price, not a real market price.';
  const priceMeta = { buyBox, hasLiveBuyBox, priceBasis, priceWarning, itemClassification };

  // No catalog match and no usable price: skip the fees round-trip entirely
  // (fees v0 is ~1 rps in production — bad ASINs must not burn the budget).
  if (catalog.error && derivedPrice === null && explicitPrice === null) {
    return {
      status: 200,
      body: {
        source: CONFIG.spapiBase.includes('sandbox') ? 'sp-api-sandbox' : 'sp-api-production',
        asin, fulfillment, catalog, offers, ...priceMeta,
        fees: { error: 'skipped — no catalog match and no usable price', skipped: true },
        feesEstimatedAt: null,
      },
    };
  }

  const fees = await safeCall(() =>
    spapiFetch(`/products/fees/v0/items/${encAsin}/feesEstimate`, {
      method: 'POST',
      body: {
        FeesEstimateRequest: {
          MarketplaceId: mkt,
          IsAmazonFulfilled: fulfillment === 'fba',
          PriceToEstimateFees: {
            ListingPrice: { CurrencyCode: 'USD', Amount: feesEstimatedAt },
          },
          Identifier: 'nexlaunch-request',
        },
      },
    })
  );

  return {
    status: 200,
    body: {
      source: CONFIG.spapiBase.includes('sandbox') ? 'sp-api-sandbox' : 'sp-api-production',
      asin, fulfillment, feesEstimatedAt, ...priceMeta, catalog, offers, fees,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// GET /api/search?q=keywords — catalog keyword search → candidate ASINs.
// Exists so tooling (attach-hunt) can resolve retail products to ASINs
// without any browser. Same token gate as /api/xray.
// ---------------------------------------------------------------------------
async function handleSearch(params) {
  const q = (params.get('q') || '').trim();
  if (!q) return { status: 400, body: { error: 'missing q' } };
  if (!isConfigured()) return { status: 503, body: { error: 'SP-API credentials not configured' } };

  const data = await spapiFetch(
    `/catalog/2022-04-01/items?keywords=${encodeURIComponent(q)}` +
    `&marketplaceIds=${CONFIG.marketplaceId}&includedData=summaries,salesRanks&pageSize=10`
  );
  const items = (data.items || []).map((it) => {
    const s = (it.summaries || [])[0] || {};
    const sr = (it.salesRanks || [])[0];
    const rank = sr && (sr.displayGroupRanks || sr.classificationRanks || [])[0];
    return {
      asin: it.asin,
      name: s.itemName || null,
      brand: s.brand || null,
      // parents can't be attached to — surface the classification honestly
      itemClassification: s.itemClassification || null,
      bsr: rank ? rank.rank : null,
      bsrCategory: rank ? rank.title : null,
    };
  });
  return { status: 200, body: { query: q, count: items.length, items } };
}

function authorized(req, url) {
  if (!CONFIG.apiToken) return true;
  const hdr = String(req.headers['authorization'] || '');
  const presented = hdr.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  return presented === CONFIG.apiToken;
}

// ---------------------------------------------------------------------------
// Accounts + billing
//
// Until now this server had exactly one kind of caller: our own tooling,
// holding a shared ops token. A paying customer cannot be given that token, so
// there was no way for one to reach live data at all - the public site is in
// demo mode partly for that reason. Sessions are the second key.
// ---------------------------------------------------------------------------

const MAX_BODY = 1024 * 1024; // 1MB - webhooks and signup forms are tiny

/** Read the raw body. Raw, not parsed: Stripe signs the exact bytes. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return null;
  }
}

const bearer = (req, url) =>
  String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
  || url.searchParams.get('token')
  || '';

/**
 * Login rate limit, per IP, in memory.
 *
 * A password endpoint with no limiter is a free offline-speed guessing oracle.
 * In-memory is honest for a single process: it resets on restart, which is a
 * real weakness, and the fix is a shared store once there is more than one box.
 */
const attempts = new Map();
function rateLimited(key, limit = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.reset) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  rec.n += 1;
  return rec.n > limit;
}
// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k);
}, 10 * 60 * 1000).unref();

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress
  || 'unknown';

/** Plans that may call the live SP-API routes. Free accounts get demo data. */
const LIVE_DATA_PLANS = new Set(['starter', 'growth', 'scale']);

/**
 * Who is calling? Either our ops token (tooling) or a signed-in customer.
 * Returns null when neither, so the caller decides the status code.
 */
function identify(req, url) {
  const presented = bearer(req, url);
  if (!presented) return null;
  if (CONFIG.apiToken && presented === CONFIG.apiToken) return { kind: 'ops' };
  const user = accounts.userForToken(presented);
  return user ? { kind: 'user', user } : null;
}

async function handleAuth(req, res, url, pathname) {
  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    if (!body) return sendJson(res, 400, { error: 'body must be JSON' });
    if (rateLimited(`signup:${clientIp(req)}`, 5)) {
      return sendJson(res, 429, { error: 'too many signups from this address, try later' });
    }
    const out = accounts.signup(body);
    if (out.error) return sendJson(res, 400, out);
    return sendJson(res, 201, out);
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    if (!body) return sendJson(res, 400, { error: 'body must be JSON' });
    if (rateLimited(`login:${clientIp(req)}`)) {
      return sendJson(res, 429, { error: 'too many attempts, try again in a few minutes' });
    }
    const out = accounts.login(body);
    if (out.error) return sendJson(res, 401, out);
    return sendJson(res, 200, out);
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = accounts.userForToken(bearer(req, url));
    if (!user) return sendJson(res, 401, { error: 'not signed in' });
    return sendJson(res, 200, { user });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    accounts.logout(bearer(req, url));
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

async function handleBilling(req, res, url, pathname) {
  if (pathname === '/api/billing/plans' && req.method === 'GET') {
    const prices = billing.priceIds(CONFIG.env || process.env);
    return sendJson(res, 200, {
      configured: billing.isConfigured(CONFIG.env || process.env),
      plans: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, Boolean(v)])),
    });
  }

  if (pathname === '/api/billing/checkout' && req.method === 'POST') {
    const user = accounts.userForToken(bearer(req, url));
    if (!user) return sendJson(res, 401, { error: 'sign in first' });
    const body = parseJson(await readBody(req));
    if (!body) return sendJson(res, 400, { error: 'body must be JSON' });
    const origin = String(req.headers.origin || '');
    const out = await billing.createCheckout(CONFIG.env || process.env, {
      user,
      plan: String(body.plan || ''),
      origin,
    });
    if (out.error) return sendJson(res, 400, out);
    return sendJson(res, 200, out);
  }

  if (pathname === '/api/billing/webhook' && req.method === 'POST') {
    // RAW body, before any parsing - the signature covers the exact bytes.
    const raw = await readBody(req);
    const verdict = billing.verifyWebhook(
      CONFIG.env || process.env,
      raw,
      req.headers['stripe-signature']
    );
    if (!verdict.ok) {
      console.log(`  webhook REJECTED: ${verdict.error}`);
      return sendJson(res, 400, { error: verdict.error });
    }
    const result = billing.applyEvent(verdict.event);
    // 200 even for events we ignore, or Stripe retries them for days and the
    // ones that matter get lost in the noise.
    console.log(`  webhook ${verdict.event.type}: ${result.ignored ? `ignored (${result.reason})` : `applied to ${result.email} -> ${result.plan || 'status only'}`}`);
    return sendJson(res, 200, { received: true });
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;

  res.on('finish', () => {
    // Log method, path, status only — never query values or secrets.
    console.log(
      `${new Date().toISOString()} ${req.method} ${url ? url.pathname : '(unparseable url)'} -> ${res.statusCode} (${Date.now() - started}ms)`
    );
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    // Parse inside the try block: a malformed request-target (e.g. an
    // absolute-form URL like `GET http://[/`) makes new URL throw, which
    // would otherwise be an unhandled rejection that kills the process.
    url = new URL(req.url, `http://localhost:${CONFIG.port}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const { status, body } = await handleHealth();
      sendJson(res, status, body);
      return;
    }
    if (url.pathname.startsWith('/api/auth/')) {
      if ((await handleAuth(req, res, url, url.pathname)) !== false) return;
    }
    if (url.pathname.startsWith('/api/billing/')) {
      if ((await handleBilling(req, res, url, url.pathname)) !== false) return;
    }

    if (req.method === 'GET' && url.pathname === '/api/xray') {
      const who = identify(req, url);
      if (!who) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (who.kind === 'user' && !LIVE_DATA_PLANS.has(who.user.plan)) {
        sendJson(res, 402, { error: 'live data needs a paid plan', plan: who.user.plan, upgrade: true });
        return;
      }
      const { status, body } = await handleXray(url.searchParams);
      sendJson(res, status, body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const who = identify(req, url);
      if (!who) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (who.kind === 'user' && !LIVE_DATA_PLANS.has(who.user.plan)) {
        sendJson(res, 402, { error: 'live data needs a paid plan', plan: who.user.plan, upgrade: true });
        return;
      }
      const { status, body } = await handleSearch(url.searchParams);
      sendJson(res, status, body);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'internal server error' });
  }
});

server.listen(CONFIG.port, () => {
  console.log(`NexLaunch SP-API server listening on http://localhost:${CONFIG.port}`);
  console.log(`  SP-API base:    ${CONFIG.spapiBase}`);
  console.log(`  Marketplace:    ${CONFIG.marketplaceId}`);
  console.log(`  Credentials:    ${isConfigured() ? 'configured' : 'NOT configured (copy server/.env.example to server/.env)'}`);
});
