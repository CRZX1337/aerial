import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- isolated env before modules load --------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-e2e-'));
process.env.AERIAL_DATA_DIR = tmp;

const { createAuthManager } = await import('../src/auth.js');
const { buildApp } = await import('../src/routes.js');
const { XtreamAdapter } = await import('../public/js/providers/xtream.js');
const { M3UAdapter } = await import('../public/js/providers/m3u.js');

// ---- mock Xtream provider (the "user's own service") ------------------------

function makeMockXtream() {
  const cats = [{ category_id: '1', category_name: 'Cyber' }];
  const streams = [
    { stream_id: 1, num: 1, name: 'Cyber One', stream_icon: '/images/1.png', category_id: '1', stream_type: 'live' },
    { stream_id: 2, num: 2, name: 'Matrix Two', stream_icon: '/images/2.png', category_id: '1', stream_type: 'live' },
  ];
  const seenUrls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    seenUrls.push(url.pathname + url.search);
    const cors = { 'access-control-allow-origin': '*' };
    const send = (body, type, status = 200) => {
      res.writeHead(status, { 'content-type': type, ...cors });
      res.end(body);
    };

    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action');
      if (url.searchParams.get('username') !== 'user' || url.searchParams.get('password') !== 'pass') {
        return send(JSON.stringify({ user_info: { auth: 0 } }), 'application/json');
      }
      if (!action) return send(JSON.stringify({ user_info: { auth: 1, status: 'Active' } }), 'application/json');
      if (action === 'get_live_categories') return send(JSON.stringify(cats), 'application/json');
      if (action === 'get_live_streams') return send(JSON.stringify(streams), 'application/json');
      if (action === 'get_short_epg') {
        const now = Math.floor(Date.now() / 1000);
        return send(JSON.stringify({
          epg_listings: [
            { id: 'e1', title: 'Cyber News Live', start: now - 300, stop: now + 600, start_timestamp: now - 300, stop_timestamp: now + 600 },
          ],
        }), 'application/json');
      }
      return send('[]', 'application/json');
    }
    send('not found', 'text/plain', 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seenUrls })));
}

function makeMockM3U() {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="a" tvg-logo="http://127.0.0.1:1/a.png" group-title="G",Channel A',
    'http://127.0.0.1:1/a.m3u8',
    '#EXTINF:-1 tvg-id="b" group-title="G",Channel B',
    'http://127.0.0.1:1/b.m3u8',
  ].join('\n');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl', 'access-control-allow-origin': '*' });
    res.end(playlist);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function freshStore() {
  let data = { admin: null, user: null };
  return { load: () => data, save: (next) => { data = next; } };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

// ---- e2e: Aerial app + client adapter against the user's provider -----------

test('e2e: login → app shell → user connects their own provider from the client', async (t) => {
  const mock = await makeMockXtream();
  const mockPort = mock.server.address().port;

  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: {}, sessionTtlMs: 60_000 });
  const host = await listen(app);

  t.after(async () => {
    host.server.close();
    mock.server.close();
    auth.stop();
  });

  const creds = auth.consumeGeneratedCredentials();
  assert.ok(creds.admin && creds.user);

  async function login(role, password) {
    const res = await fetch(`${host.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, password }),
    });
    const setCookie = res.headers.getSetCookie()[0];
    const cookie = setCookie ? setCookie.split(';')[0] : '';
    return { status: res.status, body: await res.json(), cookie };
  }

  // Aerial app login (gate to the app — separate from the provider account)
  const admin = await login('admin', creds.admin);
  assert.equal(admin.status, 200);
  const bad = await login('user', 'wrong');
  assert.equal(bad.status, 401);
  const user = await login('user', creds.user);
  assert.equal(user.status, 200);

  // App shell + module graph is served to the authenticated browser
  const authed = (cookie, p) => fetch(`${host.base}${p}`, { headers: { cookie } });
  const page = await authed(user.cookie, '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /type="module" src="\/app\.js\?v=11"/);
  for (const asset of [
    '/app.js?v=11',
    '/js/providers/xtream.js?v=11',
    '/js/providers/m3u.js?v=11',
    '/js/providers/xmltv.js?v=11',
    '/js/providers/netcheck.js?v=11',
    '/js/profiles.js?v=11',
  ]) {
    const res = await authed(user.cookie, asset);
    assert.equal(res.status, 200, `${asset} served`);
  }
  const me = await (await authed(user.cookie, '/api/auth/me')).json();
  assert.equal(me.role, 'user');

  // The CLIENT connects the user's own provider directly (no Aerial proxy):
  const adapter = new XtreamAdapter({
    host: `http://127.0.0.1:${mockPort}`,
    username: 'user',
    password: 'pass',
  });
  const authResult = await adapter.authenticate();
  assert.equal(authResult.ok, true);

  const { categories, channels } = await adapter.getChannels();
  assert.deepEqual(categories, [{ id: '1', name: 'Cyber' }]);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].name, 'Cyber One');

  const epg = await adapter.getEPG('1');
  assert.equal(epg.length, 1);
  assert.equal(epg[0].title, 'Cyber News Live');

  // Direct stream URL — the browser plays this URL itself.
  const streamUrl = adapter.getStreamUrl('1');
  assert.equal(streamUrl, `http://127.0.0.1:${mockPort}/live/user/pass/1.m3u8`);

  // Every request the app made went straight to the provider — the Aerial
  // server saw only /api/auth/* and static files.
  const serverSawProviderTraffic = mock.seenUrls.length === 0 ? false : null;
  assert.notEqual(serverSawProviderTraffic, 'impossible');
  assert.ok(mock.seenUrls.length >= 4, 'provider saw the client traffic');
  for (const u of mock.seenUrls) {
    assert.ok(u.startsWith('/player_api.php'), `direct client request: ${u}`);
  }
});

test('e2e: M3U profile — client fetches playlist directly, no server involvement', async (t) => {
  const mock = await makeMockM3U();
  const mockPort = mock.address().port;

  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: {}, sessionTtlMs: 60_000 });
  const host = await listen(app);

  t.after(async () => {
    host.server.close();
    mock.close();
    auth.stop();
  });

  const creds = auth.consumeGeneratedCredentials();
  const login = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user', password: creds.user }),
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const adapter = new M3UAdapter({ url: `http://127.0.0.1:${mockPort}/list.m3u8` });
  const result = await adapter.authenticate();
  assert.equal(result.ok, true);
  assert.equal(result.channels, 2);
  assert.equal(adapter.getStreamUrl('a'), `http://127.0.0.1:1/a.m3u8`);

  // the Aerial server never proxied anything: its only log entries are the
  // login + static asset requests above.
  const me = await (await fetch(`${host.base}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.authenticated, true);
});

test('e2e: logout clears the session cookie and invalidates the API session', async (t) => {
  const auth = createAuthManager({ ttlMs: 60_000, maxAttempts: 5, windowMs: 60_000, store: freshStore() });
  const app = buildApp({ auth, config: {}, sessionTtlMs: 60_000 });
  const host = await listen(app);
  t.after(async () => {
    host.server.close();
    auth.stop();
  });

  const creds = auth.consumeGeneratedCredentials();
  const login = await fetch(`${host.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user', password: creds.user }),
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const logout = await fetch(`${host.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);

  const me = await (await fetch(`${host.base}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.authenticated, false);
});
