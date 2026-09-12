import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appIsSecure,
  isMixedContent,
  httpsTwin,
  probeReachable,
  diagnoseFailure,
} from '../public/js/providers/netcheck.js';

function opaqueResponse() {
  // fetch with mode:'no-cors' resolves to an opaque response (type 'opaque')
  return { type: 'opaque', ok: false, status: 0 };
}

test('appIsSecure is false outside a browser (Node has no location)', () => {
  assert.equal(appIsSecure(), false);
  assert.equal(isMixedContent('http://provider.example:8080'), false);
});

test('httpsTwin converts http->https, keeps host/port/path, ignores https input', () => {
  assert.equal(httpsTwin('http://cf.example.xyz'), 'https://cf.example.xyz/');
  assert.equal(httpsTwin('http://cf.example.xyz:8080/path'), 'https://cf.example.xyz:8080/path');
  assert.equal(httpsTwin('https://cf.example.xyz'), null);
  assert.equal(httpsTwin('not a url'), null);
});

test('probeReachable resolves when the provider answers (opaque response)', async () => {
  const fetchImpl = async () => opaqueResponse();
  assert.equal(await probeReachable('http://p.example', { fetchImpl }), true);
});

test('probeReachable throws when the connection fails at network level', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(() => probeReachable('http://p.example', { fetchImpl }));
});

test('diagnoseFailure: network-level block -> actionable message', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const diag = await diagnoseFailure('http://p.example', { fetchImpl });
  assert.equal(diag.kind, 'network_blocked');
  assert.match(diag.message, /nicht erreichbar/);
  assert.match(diag.message, /Werbeblocker/);
});

test('diagnoseFailure: reachable but CORS-blocked -> specific message', async () => {
  // no-cors probe reaches the server, but the real (cors) fetch is what
  // failed before — reachable + failed cors request = CORS refusal.
  const fetchImpl = async () => opaqueResponse();
  const diag = await diagnoseFailure('http://p.example', { fetchImpl });
  assert.equal(diag.kind, 'cors_blocked');
  assert.match(diag.message, /erreichbar/);
  assert.match(diag.message, /CORS/);
});

test('diagnoseFailure never throws, even for broken fetch implementations', async () => {
  const fetchImpl = async () => {
    throw new Error('boom');
  };
  const diag = await diagnoseFailure('http://p.example', { fetchImpl });
  assert.equal(typeof diag.kind, 'string');
  assert.equal(typeof diag.message, 'string');
});
