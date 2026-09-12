import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- isolated env before modules load --------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-authopen-'));
process.env.AERIAL_DATA_DIR = tmp;

const { createAuthManager } = await import('../src/auth.js');
const { buildApp } = await import('../src/routes.js');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-store-'));
  return {
    load: () => ({ admin: null, user: null }),
    save: () => {},
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

test('AUTH_OPEN=true: /api/auth/me reports an open session without login', async (t) => {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: { authOpen: true }, sessionTtlMs: 60_000 });
  const host = await listen(app);
  t.after(() => { host.close(); auth.stop(); });

  const res = await fetch(`${host.base}/api/auth/me`);
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.authenticated, true);
  assert.equal(me.role, 'user');
  assert.equal(me.authMode, 'open');
});

test('AUTH_OPEN unset: classic behaviour (unauthenticated, no authMode field)', async (t) => {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: {}, sessionTtlMs: 60_000 });
  const host = await listen(app);
  t.after(() => { host.close(); auth.stop(); });

  const res = await fetch(`${host.base}/api/auth/me`);
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.authenticated, false);
  assert.equal(me.role, null);
  assert.equal(me.authMode, undefined);
});

test('AUTH_OPEN=true: app login endpoint still works (future-gating kept intact)', async (t) => {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const creds = auth.consumeGeneratedCredentials();
  assert.ok(creds.admin && creds.user);
  const app = buildApp({ auth, config: { authOpen: true }, sessionTtlMs: 60_000 });
  const host = await listen(app);
  t.after(() => { host.close(); auth.stop(); });

  const res = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', password: creds.admin }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.role, 'admin');
});

test('AUTH_OPEN=true: static app shell is served (boot path needs no cookie)', async (t) => {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: { authOpen: true }, sessionTtlMs: 60_000 });
  const host = await listen(app);
  t.after(() => { host.close(); auth.stop(); });

  const page = await fetch(`${host.base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  // The open-mode bootstrap must be loaded BEFORE the app module.
  const authModeIdx = html.indexOf('/auth-mode.js?v=1');
  const appIdx = html.indexOf('/app.js?v=11');
  assert.ok(authModeIdx !== -1, 'auth-mode.js referenced');
  assert.ok(appIdx !== -1, 'app.js referenced');
  assert.ok(authModeIdx < appIdx, 'auth-mode.js loads before app.js');
});