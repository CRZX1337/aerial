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

function isTimeoutError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Stage-by-stage diagnosis: runs the provider's real request sequence
 * (auth -> categories -> channel list) and identifies WHICH step fails and
 * why. This distinguishes:
 *  - provider HTTP errors (status readable, CORS headers present)
 *  - timeouts on large transfers (slow/unstable connection)
 *  - blocked/challenged browser requests (Cloudflare/WAF: reachable via
 *    no-cors but the CORS read fails)
 *  - genuine network blocks (DNS/firewall/adblocker)
 *
 * stages: [{ label, url, timeoutMs? }] — returns
 * { kind, stageLabel, message, testUrl? } and never throws.
 * kind 'ok' means every stage passed NOW (the original failure was
 * transient — worth retrying).
 */
export async function diagnoseStages(stages, { fetchImpl = fetch } = {}) {
  const fail = (kind, stageLabel, message, testUrl) => ({ kind, stageLabel, message, testUrl });
  try {
    if (!Array.isArray(stages) || !stages.length) {
      return fail('unknown', '', 'Die Verbindung konnte nicht aufgebaut werden.');
    }
    if (isMixedContent(stages[0].url)) {
      return fail(
        'mixed_content',
        stages[0].label,
        'Der Browser blockiert die Verbindung: Die App läuft über HTTPS, der Anbieter aber über HTTP (Mixed Content). ' +
          'Lösung: den Anbieter mit einer HTTPS-URL eintragen (https://…).',
      );
    }

    for (const stage of stages) {
      try {
        const res = await probeCors(stage.url, { fetchImpl, timeoutMs: stage.timeoutMs });
        if (!res.ok) {
          return fail(
            'http_error',
            stage.label,
            `Der Anbieter hat bei „${stage.label}" mit HTTP ${res.status} geantwortet. ` +
              'Zugangsdaten bzw. Anbieter-Status prüfen.',
            stage.url,
          );
        }
        // stage OK — release the body without downloading it (catalogs can
        // be 20 MB; diagnosis only needs the status + CORS headers).
        try {
          if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
        } catch { /* already drained */ }
      } catch (err) {
        if (isTimeoutError(err)) {
          return fail(
            'timeout',
            stage.label,
            `„${stage.label}" wurde abgebrochen — die Verbindung ist zu langsam oder instabil (bei riesigen Senderlisten können über 20 MB übertragen werden). ` +
              'Lösungen: stabiles WLAN verwenden, VPN testen und danach erneut verbinden.',
            stage.url,
          );
        }
        // Network-level vs blocked/challenged: probe the SAME url opaque.
        let reachable = false;
        try {
          await probeReachable(stage.url, { fetchImpl });
          reachable = true;
        } catch {
          reachable = false;
        }
        if (!reachable) {
          return fail(
            'network_blocked',
            stage.label,
            'Der Anbieter ist von diesem Gerät/Netz aus nicht erreichbar (DNS, Firewall, Werbeblocker oder Anbieter offline). ' +
              'Lösungen: Werbeblocker/Privacy-Erweiterung für diese App deaktivieren, VPN ein-/ausschalten, ' +
              'anderes Netzwerk testen (z. B. Mobilfunk statt WLAN).',
          );
        }
        return fail(
          'blocked_or_cors',
          stage.label,
            `Der Anbieter hat die Browser-Anfrage bei „${stage.label}" blockiert (z. B. Cloudflare-/Sicherheitsfilter) oder erlaubt keine Browser-Verbindung (CORS). ` +
            'Zum Selbst-Test die Anbieter-Adresse unten direkt im Browser öffnen: Erscheinen dort Daten, ist es ein App-Problem (bitte melden). ' +
            'Erscheint eine Prüf-/Blockseite, blockiert der Anbieter dein Gerät oder Netzwerk (z. B. wegen VPN, Adblocker oder IP-Filter) — ' +
            'anderes Netzwerk/VPN testen oder den Anbieter kontaktieren.',
          stage.url,
        );
      }
    }
    return { kind: 'ok', stageLabel: '', message: '' };
  } catch {
    return fail('unknown', '', 'Die Verbindung konnte nicht aufgebaut werden.');
  }
}
