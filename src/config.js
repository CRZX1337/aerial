import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (no dependency). KEY=VALUE lines, # comments, optional quotes. */
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file is fine.
  }
}

loadEnvFile(path.join(ROOT, '.env'));

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : v; // 'loopback', 'uniquelocal', CIDR
}

function parseCookieSecure(v) {
  if (v === undefined || v === '' || v === 'auto') return 'auto';
  return v === 'true' || v === '1';
}

export const ROOT_DIR = ROOT;
export const DATA_DIR = process.env.AERIAL_DATA_DIR
  ? path.resolve(process.env.AERIAL_DATA_DIR)
  : path.join(ROOT, 'data');

export const config = {
  port: intEnv('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',

  sessionTtlMs: intEnv('SESSION_TTL_MS', 24 * 60 * 60 * 1000),

  loginMaxAttempts: intEnv('LOGIN_MAX_ATTEMPTS', 8),
  loginWindowMs: intEnv('LOGIN_WINDOW_MS', 5 * 60 * 1000),

  // 'auto' (default): Secure flag when the request looks like HTTPS.
  // true/false forces the behaviour (set true when serving behind TLS).
  cookieSecure: parseCookieSecure(process.env.COOKIE_SECURE),
  // Express `trust proxy` setting: false (default), true, hop count,
  // 'loopback', 'uniquelocal' or CIDR — see Express docs.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};
