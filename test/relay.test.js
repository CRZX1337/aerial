import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-relay-'));
process.env.AERIAL_DATA_DIR = tmp;

const { relayFetch, RelayError } = await import('../src/relay.js');

function startProvider() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    hits.push(url.pathname);
    if (url.pathname === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, stream_id: 1 }));
    }
    if (url.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let i = 0; i < 40; i++) res.write(chunk); // 2.5 MB
      return res.end();
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/data.json' });
      return res.end();
    }
    if (url.pathname === '/redirect-bad') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    if (url.pathname === '/flaky') {
      if (hits.filter((h) => h === '/flaky').length < 2) {
        res.destroy(); // transport reset — retryable
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('recovered');
    }
    if (url.pathname === '/teapot') {
      res.writeHead(418, { 'content-type': 'text/plain' });
      return res.end("I'm a teapot");
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

test('relayFetch streams provider responses with status + headers', async () => {
  const p = await startProvider();
  try {
    const res = await relayFetch(`http://127.0.0.1:${p.port}/data.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    const text = await streamToString(res.body);
    assert.equal(JSON.parse(text).ok, true);
  } finally {
    p.server.close();
  }
});

test('relayFetch forwards provider HTTP errors as-is (no retry, real status)', async () => {
  const p = await startProvider();
  try {
    const res = await relayFetch(`http://127.0.0.1:${p.port}/teapot`);
    assert.equal(res.status, 418);
    const text = await streamToString(res.body);
    assert.match(text, /teapot/);
  } finally {
    p.server.close();
  }
});

test('relayFetch retries transport resets automatically', async () => {
  const p = await startProvider();
  try {
    const res = await relayFetch(`http://127.0.0.1:${p.port}/flaky`);
    assert.equal(res.status, 200);
    const text = await streamToString(res.body);
    assert.equal(text, 'recovered');
    assert.equal(p.hits.filter((h) => h === '/flaky').length, 2, 'exactly one retry');
  } finally {
    p.server.close();
  }
});

test('relayFetch follows validated redirects', async () => {
  const p = await startProvider();
  try {
    const res = await relayFetch(`http://127.0.0.1:${p.port}/redirect`);
    assert.equal(res.status, 200);
    const text = await streamToString(res.body);
    assert.equal(JSON.parse(text).ok, true);
  } finally {
    p.server.close();
  }
});

test('relayFetch rejects non-http(s) protocols and credential URLs', async () => {
  await assert.rejects(() => relayFetch('file:///etc/passwd'), RelayError);
  await assert.rejects(() => relayFetch('ftp://x/y'), RelayError);
  await assert.rejects(() => relayFetch('http://user:pass@host/path'), RelayError);
  await assert.rejects(() => relayFetch('not a url'), RelayError);
});

test('relayFetch rejects dangerous redirect targets', async () => {
  const p = await startProvider();
  try {
    await assert.rejects(
      () => relayFetch(`http://127.0.0.1:${p.port}/redirect-bad`),
      (err) => err instanceof RelayError && err.code === 'relay_redirect',
    );
  } finally {
    p.server.close();
  }
});

test('relayFetch streams large bodies completely (2.5 MB)', async () => {
  const p = await startProvider();
  try {
    const res = await relayFetch(`http://127.0.0.1:${p.port}/big`);
    assert.equal(res.status, 200);
    const buf = await streamToBuffer(res.body);
    assert.equal(buf.length, 64 * 1024 * 40);
    assert.ok(buf.every((b) => b === 7));
  } finally {
    p.server.close();
  }
});

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
