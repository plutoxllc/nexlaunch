// NexLaunch frontend adapter for the local SP-API sandbox server.
// Self-contained — no edits to other files required. Include with:
//   <script src="js/api.js"></script>
// Callers should treat a null return as "server unavailable" and fall back
// to demo data.
(function () {
  'use strict';

  // Default: local server. Override (e.g. to a VPS) with:
  //   NexApi.configure({ base: 'http://5.161.117.84:4879', token: '...' })
  // — persisted in localStorage. NexApi.configure(null) resets to local.
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem('nexlaunch_api') || '{}') || {}; } catch (e) {}
  var BASE_URL = stored.base || 'http://localhost:4879';
  var API_TOKEN = stored.token || '';
  // Production /api/xray is two sequential SP-API round-trips (catalog+offers,
  // then fees at the real Buy Box price) plus a possible LWA token exchange —
  // keep this generous; failures still silently fall back to demo data.
  var TIMEOUT_MS = 10000;

  function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, TIMEOUT_MS);

    var opts = { signal: controller.signal };
    if (API_TOKEN) opts.headers = { Authorization: 'Bearer ' + API_TOKEN };
    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) {
          // Non-2xx (e.g. credentials not configured) — treat as
          // unavailable so callers fall back to demo data.
          return null;
        }
        return res.json();
      })
      .catch(function () {
        // Server down, timeout, CORS, bad JSON — all silently map to null.
        return null;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  window.NexApi = {
    /**
     * Fetch live X-Ray data for an ASIN (or search query) from the local
     * SP-API sandbox server. Resolves to the parsed JSON payload, or null
     * on any failure (server not running, timeout, or a non-2xx error
     * response — callers should fall back to demo data).
     *
     * opts.fulfillment — 'fba' (default, Amazon-fulfilled: fees include the
     * FBA fulfillment fee) or 'fbm' (merchant-fulfilled / dropship: referral
     * fee only, no FBA fee). Omitting opts keeps the historical FBA behavior.
     */
    serverXray: function (asinOrQuery, opts) {
      var url =
        BASE_URL + '/api/xray?asin=' + encodeURIComponent(asinOrQuery || '');
      var f = opts && opts.fulfillment;
      if (f === 'fbm' || f === 'fba') url += '&fulfillment=' + f;
      return fetchJson(url);
    },

    /**
     * Check whether the local server is up and configured.
     * Resolves to { ok, configured } or null if the server is unreachable.
     */
    health: function () {
      return fetchJson(BASE_URL + '/api/health');
    },

    /**
     * Point the adapter at a different API server (persisted).
     * configure({ base, token }) — configure(null) resets to localhost.
     */
    configure: function (cfg) {
      if (cfg && cfg.base) {
        localStorage.setItem('nexlaunch_api', JSON.stringify({ base: cfg.base, token: cfg.token || '' }));
      } else {
        localStorage.removeItem('nexlaunch_api');
      }
      location.reload();
    },
  };
})();
