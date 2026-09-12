// Client-side provider fetch that routes through the user's OWN Aerial
// server (POST /api/relay) instead of the browser hitting the provider
// directly. Same architectural pattern as IPTVnator's self-hosted web
// backend.
//
// Why: browsers kill long fetches (tab throttling, backgrounding) and
// max_connections=1 IPTV accounts drop big catalog downloads as soon as
// player/EPG traffic competes for the single connection. The server has
// neither limit and adds retries.
//
// Returns fetch-like Response objects (res.ok, res.status, res.json(),
// res.text(), res.body) so the provider adapters work unchanged.

async function relayFetch(url, opts = {}) {
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: String(url) }),
    signal: opts.signal, // propagate abort/timeout signals
  });

  if (!res.ok) {
    // Relay/server errors: surface a TypeError-compatible network error so
    // adapter error classification keeps working, enriched with the code.
    let code = 'relay_failed';
    try {
      const body = await res.json();
      if (body && body.error) code = body.error;
    } catch { /* non-json */ }
    const err = new TypeError(`Relay request failed (${code})`);
    err.relayCode = code;
    throw err;
  }
  return res;
}

/** True when the app is served over http(s) (relay needs same-origin). */
export function relaySupported() {
  return (
    typeof location !== 'undefined' &&
    (location.protocol === 'http:' || location.protocol === 'https:')
  );
}

/**
 * Build a fetch implementation for a provider adapter. When useRelay is
 * true, catalog/EPG requests go through the user's own server; playback
 * URLs stay direct (native HLS needs no CORS, hls.js providers send ACAO).
 */
export function makeProviderFetch({ useRelay } = {}) {
  if (!useRelay || !relaySupported()) return fetch;
  return relayFetch;
}
