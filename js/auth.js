/* ============================================================================
   NexLaunch — auth client
   ----------------------------------------------------------------------------
   Replaces the old "account": a JSON blob the browser wrote into localStorage
   for itself (name + email, no password). Anyone could type
     localStorage.nexlaunch_account = '{"plan":"scale"}'
   and have the paid dashboard, because no server had ever heard of them.

   What is stored now is a SESSION TOKEN, which the server issued and can
   revoke. The plan is never read from storage — it is whatever /api/auth/me
   says it is, because the browser must not be able to assert what it paid for.

   The token lives in localStorage, which is readable by any script that gets
   onto the page. That is the standard trade for a static frontend talking to a
   separate API origin (cookies need same-site or a CORS credentials dance).
   The mitigation that matters is not storing anything else next to it.
   ========================================================================== */
window.NexAuth = (function () {
  'use strict';

  var TOKEN_KEY = 'nexlaunch_token';
  var LEGACY_KEY = 'nexlaunch_account';

  function base() {
    // Share whatever js/api.js was pointed at, so there is one API origin.
    try {
      var stored = JSON.parse(localStorage.getItem('nexlaunch_api') || '{}');
      if (stored && stored.base) return stored.base;
    } catch (e) { /* fall through */ }
    return 'http://localhost:4879';
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
      // The old fake account is actively misleading if left behind: the
      // dashboard used to read its `plan` field.
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) { /* private mode */ }
  }

  function call(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(base() + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    }).catch(function () {
      // The API being down must not read as "your password was wrong".
      return { status: 0, ok: false, body: { error: 'cannot reach the NexLaunch API', offline: true } };
    });
  }

  return {
    isSignedIn: function () { return Boolean(token()); },

    signup: function (fields) {
      return call('/api/auth/signup', { method: 'POST', body: fields }).then(function (r) {
        if (r.ok && r.body.token) setToken(r.body.token);
        return r;
      });
    },

    login: function (fields) {
      return call('/api/auth/login', { method: 'POST', body: fields }).then(function (r) {
        if (r.ok && r.body.token) setToken(r.body.token);
        return r;
      });
    },

    /** The authority on who this is and what they pay for. */
    me: function () {
      if (!token()) return Promise.resolve(null);
      return call('/api/auth/me').then(function (r) {
        if (r.status === 401) { setToken(''); return null; }
        // On a network failure return undefined, NOT null: null means "signed
        // out" and would bounce a paying customer to the landing page because
        // their wifi blipped.
        if (!r.ok) return undefined;
        return r.body.user || null;
      });
    },

    logout: function () {
      return call('/api/auth/logout', { method: 'POST' }).then(function () {
        setToken('');
      });
    },

    /** Start Stripe Checkout. Returns {error} or redirects. */
    checkout: function (plan) {
      return call('/api/billing/checkout', { method: 'POST', body: { plan: plan } })
        .then(function (r) {
          if (r.ok && r.body.url) { window.location.href = r.body.url; return null; }
          return r.body.error || 'could not start checkout';
        });
    },

    planLabel: function (user) {
      if (!user) return 'Signed out';
      var p = user.plan || 'free';
      if (p === 'free') return 'Free';
      var status = user.planStatus === 'past_due' ? ' (payment failed)' : '';
      return p.charAt(0).toUpperCase() + p.slice(1) + status;
    }
  };
})();
