import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- isolated env before modules load --------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-security-'));
process.env.AERIAL_DATA_DIR = tmp;

const { createAuthManager } = await import('../src/auth.js');
const { buildApp } = await import('../src/routes.js');

function freshStore() {
  let data = { admin: null, user: null };
  return { load: () => data, save: (next) => { data = next; } };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function makeStack(configOverride) {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: configOverride || {}, sessionTtlMs: 60_000 });
  return { auth, app };
}

test('CSP: strict app code, provider origins allowed for media/connect (player model)', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);

  const page = await fetch(`${host.base}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header present');
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https:",
    "img-src 'self' http: https: data:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ]) {
    assert.ok(csp.includes(directive), `CSP contains ${directive}`);
  }
  // The important XSS surface stays strict:
  assert.ok(!csp.includes('*'));
  assert.ok(!csp.includes('unsafe-eval'));
  assert.ok(!csp.includes('unsafe-inline'));
  // ... while only media-relevant directives open provider origins:
  const opened = csp
    .split(';')
    .filter((d) => d.includes('http:'))
    .map((d) => d.trim().split(' ')[0]);
  assert.deepEqual(
    [...new Set(opened)].sort(),
    ['connect-src', 'img-src', 'media-src'],
    'only media/connect/img allow arbitrary provider origins',
  );

  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  host.server.close();
  auth.stop();
});

test('the player API surface is gone: streaming endpoints return 404', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);
  const creds = auth.consumeGeneratedCredentials();
  const login = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: creds.admin }),
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const authed = (p) => fetch(`${host.base}${p}`, { headers: { cookie } });
  for (const p of [
    '/api/channels',
    '/api/state',
    '/api/epg/1',
    '/api/control/play',
    '/api/control/stop',
    '/api/stream/1/playlist.m3u8',
    '/api/stream/1/raw/token',
    '/api/media/token',
    '/api/events',
  ]) {
    const res = await authed(p);
    assert.equal(res.status, 404, `${p} must be gone in the player model`);
  }
  host.server.close();
  auth.stop();
});

test('provider credentials never appear in any server response (nothing to leak by design)', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);
  const creds = auth.consumeGeneratedCredentials();
  const login = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user', password: creds.user }),
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const me = await (await fetch(`${host.base}/api/auth/me`, { headers: { cookie } })).json();
  const meStr = JSON.stringify(me);
  assert.equal(me.authenticated, true);
  assert.ok(!meStr.includes('xtream'), 'no provider fields');
  assert.ok(!meStr.includes('password'), 'no credential fields');
  assert.ok(!meStr.includes('host'), 'no provider host fields');

  // Even the login response carries only the role — never any secret.
  const loginBody = JSON.stringify(await login.json());
  assert.ok(!loginBody.toLowerCase().includes(creds.user));
  host.server.close();
  auth.stop();
});

test('session cookie: HttpOnly, SameSite=Lax, Path=/; Secure only when HTTPS is detected', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);
  const creds = auth.consumeGeneratedCredentials();

  const res = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: creds.admin }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /aerial_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/i); // plain HTTP: no Secure flag

  const res2 = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ role: 'user', password: creds.user }),
  });
  assert.equal(res2.status, 200);
  assert.match(res2.headers.getSetCookie()[0], /Secure/i);

  host.server.close();
  auth.stop();
});

test('COOKIE_SECURE=true forces the Secure flag even over plain HTTP config', async () => {
  const { auth, app } = makeStack({ cookieSecure: true });
  const host = await listen(app);
  const creds = auth.consumeGeneratedCredentials();

  const res = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: creds.admin }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie()[0], /Secure/i);

  host.server.close();
  auth.stop();
});

test('manifest route serves application/manifest+json with caching', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);

  const res = await fetch(`${host.base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/manifest+json');
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  const manifest = await res.json();
  assert.equal(manifest.display, 'standalone');

  host.server.close();
  auth.stop();
});

test('app icons are served with long-lived cache headers', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);

  const icon = await fetch(`${host.base}/icons/icon-192.png`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/png/);
  assert.match(icon.headers.get('cache-control'), /max-age=86400/);

  const touch = await fetch(`${host.base}/icons/apple-touch-icon.png`);
  assert.equal(touch.status, 200);

  host.server.close();
  auth.stop();
});

test('login rate limiting still protects the auth endpoints', async () => {
  const { auth, app } = makeStack();
  const host = await listen(app);
  const creds = auth.consumeGeneratedCredentials();

  for (let i = 0; i < 5; i++) {
    const bad = await fetch(`${host.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin', password: 'wrong' }),
    });
    assert.equal(bad.status, 401);
  }
  const limited = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: creds.admin }),
  });
  assert.equal(limited.status, 429);

  host.server.close();
  auth.stop();
});

test('relay endpoint: session-gated, streams provider data, rejects bad input', async (t) => {
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ user_info: { auth: 1 } }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nf');
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;

  const { auth, app } = makeStack();
  const host = await listen(app);
  t.after(() => {
    host.server.close();
    provider.close();
    auth.stop();
  });

  const relay = (cookie, url, method = 'POST') =>
    fetch(`${host.base}/api/relay`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ url }),
    });

  // unauthenticated -> 401
  const anon = await relay(null, `${providerBase}/api.json`);
  assert.equal(anon.status, 401);

  // login and relay successfully
  const creds = auth.consumeGeneratedCredentials();
  const login = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user', password: creds.user }),
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const ok = await relay(cookie, `${providerBase}/api.json`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-aerial-relay'), '1');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = await ok.json();
  assert.equal(body.user_info.auth, 1);

  // provider HTTP error is forwarded as-is
  const nf = await relay(cookie, `${providerBase}/nope`);
  assert.equal(nf.status, 404);

  // bad input rejected
  const badProto = await relay(cookie, 'file:///etc/passwd');
  assert.equal(badProto.status, 400);
  const noUrl = await relay(cookie, '');
  assert.equal(noUrl.status, 400);

  // GET is not the relay verb (CSRF-harder surface)
  const get = await fetch(`${host.base}/api/relay`, { headers: { cookie } });
  assert.equal(get.status, 404); // no GET route -> not_found
});
