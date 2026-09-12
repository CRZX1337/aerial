import http from 'node:http';
import https from 'node:https';

/**
 * Opt-in provider relay (same architectural pattern as IPTVnator's
 * self-hosted web backend): the user's OWN Aerial server fetches provider
 * URLs server-side and streams the response back to the browser.
 *
 * Why this exists: browsers kill long-running fetches (tab throttling,
 * backgrounding, memory pressure), and IPTV accounts with
 * max_connections=1 drop the catalog download as soon as the player or an
 * EPG request competes for the single connection. A Node server has none
 * of those limits and can retry + bundle requests.
 *
 * Security model:
 *  - endpoint is session-authenticated (see routes.js)
 *  - URLs are NEVER logged (they contain provider credentials)
 *  - only http/https, no redirects followed blindly (re-validated, max 3)
 *  - one retry on transport errors; long budget for huge catalogs
 *  - this is the user's own server fetching the user's own provider —
 *    private/LAN targets are allowed deliberately (home Xtream panels)
 */

const RELAY_TIMEOUT_MS = 300_000; // 5 min — 20+ MB catalogs on slow links
const RELAY_RETRIES = 2;
const MAX_REDIRECTS = 3;

export class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assertRelayableUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new RelayError(400, 'bad_url', 'Invalid relay URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RelayError(400, 'bad_protocol', 'Only http/https URLs can be relayed');
  }
  if (u.username || u.password) {
    throw new RelayError(400, 'credentials_in_url', 'Relay URL must not embed credentials');
  }
  return u;
}

function requestOnce(u, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: {
        'user-agent': 'Aerial/1.0 (relay)',
        accept: '*/*',
        'accept-encoding': 'identity', // keep headers/body consistent when streamed
      },
    });
    const timer = setTimeout(() => {
      req.destroy(new RelayError(504, 'relay_timeout', 'Relay request timed out'));
    }, timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof RelayError ? err : new RelayError(502, 'relay_network', 'Relay upstream request failed'));
    });
    req.end();
  });
}

const NULL_BODY = new Set([204, 205, 304]);

/**
 * Fetch a provider URL server-side. Resolves with the raw Node response
 * (streamed); caller pipes it to the client. Transport failures are
 * retried; provider HTTP errors (401, 403, …) are returned as-is so the
 * client sees the provider's real status.
 */
export async function relayFetch(rawUrl, { timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  let current = assertRelayableUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= RELAY_RETRIES; attempt++) {
      try {
        res = await requestOnce(current, timeoutMs);
        break;
      } catch (err) {
        lastErr = err;
        if (err.status !== 502 && err.status !== 504) throw err; // not retryable
      }
    }
    if (!res) throw lastErr;

    const status = res.statusCode || 502;
    if (status >= 300 && status < 400 && res.headers.location) {
      let next;
      try {
        next = assertRelayableUrl(new URL(res.headers.location, current).toString());
      } catch {
        res.destroy();
        throw new RelayError(502, 'relay_redirect', 'Relay redirect target rejected');
      }
      res.resume(); // drain and release the socket
      current = next;
      continue;
    }
    if (NULL_BODY.has(status) || status < 200) {
      res.resume();
      return { status, headers: {}, body: null, empty: true };
    }
    return { status, headers: res.headers, body: res, empty: false };
  }
  throw new RelayError(502, 'relay_redirects', 'Too many relay redirects');
}
