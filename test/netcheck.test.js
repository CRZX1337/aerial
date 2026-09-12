import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appIsSecure,
  isMixedContent,
  httpsTwin,
  probeReachable,
  diagnoseFailure,
  diagnoseStages,
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

// ------------------------------------------------------- diagnoseStages -----

function okResponse() {
  return new Response('{"user_info":{"auth":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
}

const STAGES = [
  { label: 'Anmeldung', url: 'http://p.example/player_api.php?x=1', timeoutMs: 1000 },
  { label: 'Kategorien', url: 'http://p.example/player_api.php?x=2', timeoutMs: 1000 },
  { label: 'Senderliste', url: 'http://p.example/player_api.php?x=3', timeoutMs: 1000 },
];

test('diagnoseStages: all stages pass -> kind ok (transient failure)', async () => {
  const fetchImpl = async () => okResponse();
  const diag = await diagnoseStages(STAGES, { fetchImpl });
  assert.equal(diag.kind, 'ok');
});

test('diagnoseStages: HTTP error identifies the failing stage', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('x=2')) return new Response('nope', { status: 503 });
    return okResponse();
  };
  const diag = await diagnoseStages(STAGES, { fetchImpl });
  assert.equal(diag.kind, 'http_error');
  assert.equal(diag.stageLabel, 'Kategorien');
  assert.match(diag.message, /503/);
  assert.equal(diag.testUrl, STAGES[1].url);
});

test('diagnoseStages: timeout identifies the stage and stays friendly', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('x=3')) {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    return okResponse();
  };
  const diag = await diagnoseStages(STAGES, { fetchImpl });
  assert.equal(diag.kind, 'timeout');
  assert.equal(diag.stageLabel, 'Senderliste');
  assert.match(diag.message, /Senderliste/);
  assert.match(diag.message, /zu langsam/);
});

test('diagnoseStages: network block (no-cors also fails) -> network_blocked', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const diag = await diagnoseStages(STAGES, { fetchImpl });
  assert.equal(diag.kind, 'network_blocked');
  assert.match(diag.message, /nicht erreichbar/);
});

test('diagnoseStages: reachable but blocked/challenged -> blocked_or_cors with self-test URL', async () => {
  const fetchImpl = async (url, opts) => {
    // opaque probe (mode no-cors) resolves; the CORS read throws
    if (opts && opts.mode === 'no-cors') return { type: 'opaque' };
    throw new TypeError('Failed to fetch');
  };
  const diag = await diagnoseStages(STAGES, { fetchImpl });
  assert.equal(diag.kind, 'blocked_or_cors');
  assert.equal(diag.stageLabel, 'Anmeldung');
  assert.match(diag.message, /Selbst-Test/);
  assert.equal(diag.testUrl, STAGES[0].url);
});

test('diagnoseStages: never throws and tolerates garbage input', async () => {
  const diag = await diagnoseStages(null);
  assert.equal(diag.kind, 'unknown');
  const diag2 = await diagnoseStages([], { fetchImpl: async () => okResponse() });
  assert.equal(diag2.kind, 'unknown');
});

// ------------------------------------------- throughput probing (probeBytes) --

function streamBody(chunks, { stall = false } = {}) {
  return new ReadableStream({
    start(controller) {
      if (stall) return; // never enqueues — reads hang forever
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function responseWithBody(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('diagnoseStages: probeBytes measures real download throughput', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('x=3')) {
      // 300 KB of body data — the probe reads 256 KB of it and cancels the rest
      return responseWithBody(streamBody([new Uint8Array(150_000), new Uint8Array(150_000)]));
    }
    return okResponse();
  };
  const stages = [
    ...STAGES.slice(0, 2),
    { ...STAGES[2], probeBytes: 262_144, probeBudgetMs: 5_000 },
  ];
  const diag = await diagnoseStages(stages, { fetchImpl });
  assert.equal(diag.kind, 'ok');
  assert.ok(diag.throughputKBs > 0, `throughput measured: ${diag.throughputKBs} KB/s`);
});

test('diagnoseStages: stalled body within the probe budget -> timeout diagnosis', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('x=3')) return responseWithBody(streamBody([], { stall: true }));
    return okResponse();
  };
  const stages = [
    ...STAGES.slice(0, 2),
    { ...STAGES[2], probeBytes: 262_144, probeBudgetMs: 50 },
  ];
  const diag = await diagnoseStages(stages, { fetchImpl });
  assert.equal(diag.kind, 'timeout');
  assert.equal(diag.stageLabel, 'Senderliste');
  assert.match(diag.message, /zu langsam/);
});

test('diagnoseStages: body probing degrades silently without streams', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: null, // very old browsers: no body stream exposed
  });
  const stages = [{ ...STAGES[0], probeBytes: 262_144 }];
  const diag = await diagnoseStages(stages, { fetchImpl });
  assert.equal(diag.kind, 'ok');
  assert.equal(diag.throughputKBs, 0);
});
