// Browser-side provider connection diagnostics.
//
// When a direct client->provider connection fails, browsers only report a
// generic TypeError — DNS blocks, firewalls, adblocker extensions, ISP
// filters, mixed content and genuine CORS refusals all look the same.
// This module runs targeted probes to identify the ACTUAL cause so the app
// can show an actionable message instead of a vague "network or CORS".

const PROBE_TIMEOUT_MS = 12_000;

function makeSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/** True when the app itself runs on HTTPS (mixed content then applies). */
export function appIsSecure() {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

/** True when providerUrl is http:// (blocked from an https:// app). */
export function isMixedContent(providerUrl) {
  try {
    return appIsSecure() && new URL(providerUrl).protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Opaque reachability probe: `mode: 'no-cors'` bypasses CORS reading rules.
 * A resolved (opaque) response proves TCP+HTTP reached the provider; a
 * throw proves the connection never completed (DNS / firewall / extension /
 * offline / mixed content).
 */
export async function probeReachable(url, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    mode: 'no-cors',
    cache: 'no-store',
    signal: makeSignal(timeoutMs),
  });
  return res.type === 'opaque' || res.type === 'basic' || res.type === 'cors';
}

/**
 * Normal CORS probe (GET, simple headers). Resolves with the response —
 * which proves the provider sent usable CORS headers.
 */
export async function probeCors(url, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return fetchImpl(url, {
    cache: 'no-store',
    signal: makeSignal(timeoutMs),
  });
}

/** https:// twin of an http:// URL (same host/port/path). */
export function httpsTwin(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return null;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Diagnose why a connection failed. Never throws — always returns a
 * structured result with a ready-to-show German message.
 */
export async function diagnoseFailure(providerUrl, { fetchImpl = fetch } = {}) {
  const result = { providerUrl, kind: 'unknown', message: '' };
  try {
    if (isMixedContent(providerUrl)) {
      result.kind = 'mixed_content';
      result.message =
        'Der Browser blockiert die Verbindung: Die App läuft über HTTPS, der Anbieter aber über HTTP (Mixed Content). ' +
        'Lösung: den Anbieter mit einer HTTPS-URL eintragen (https://…).';
      return result;
    }

    let reachable = false;
    try {
      await probeReachable(providerUrl, { fetchImpl });
      reachable = true;
    } catch {
      reachable = false;
    }

    if (!reachable) {
      result.kind = 'network_blocked';
      result.message =
        'Der Anbieter ist von diesem Gerät/Netz aus nicht erreichbar (DNS, Firewall, Werbeblocker oder Anbieter offline). ' +
        'Lösungen: Werbeblocker/Privacy-Erweiterung für diese App deaktivieren, HTTPS-URL des Anbieters verwenden, ' +
        'anderes Netzwerk testen (z. B. Mobilfunk) oder den Anbieter-Status prüfen.';
      return result;
    }

    result.kind = 'cors_blocked';
    result.message =
      'Der Anbieter ist erreichbar, erlaubt aber keine Browser-Verbindung (fehlende CORS-Header). ' +
      'Lösung: HTTPS-URL des Anbieters testen oder den Anbieter fragen, ob er CORS für player_api.php aktivieren kann.';
    return result;
  } catch {
    result.kind = 'unknown';
    result.message = 'Die Verbindung konnte nicht aufgebaut werden.';
    return result;
  }
}
