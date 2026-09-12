import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { parseM3U, M3UAdapter } from '../public/js/providers/m3u.js';
import { XtreamAdapter } from '../public/js/providers/xtream.js';
import { parseXMLTV, shortEpg, parseXmltvTime, fetchXmltv } from '../public/js/providers/xmltv.js';

// ------------------------------------------------------------ M3U parsing ----

test('parseM3U: basic playlist with attributes, categories and stream URLs', () => {
  const text = [
    '#EXTM3U x-tvg-url="http://epg.example/guide.xml.gz"',
    '#EXTINF:-1 tvg-id="ard.de" tvg-logo="http://x/ard.png" group-title="News",ARD HD',
    'http://provider/ard.m3u8',
    '#EXTINF:-1 tvg-id="zdf.de" group-title="News",ZDF HD',
    'http://provider/zdf.ts',
    '#EXTINF:-1,RTL',
    'http://provider/rtl.m3u8',
    '#EXTVLCOPT:http-user-agent=foo',
  ].join('\n');

  const r = parseM3U(text);
  assert.equal(r.channels.length, 3);
  assert.equal(r.categories.length, 2);
  assert.equal(r.epgUrl, 'http://epg.example/guide.xml.gz');

  const ard = r.channels[0];
  assert.equal(ard.id, 'ard.de');
  assert.equal(ard.tvgId, 'ard.de');
  assert.equal(ard.name, 'ARD HD');
  assert.equal(ard.logo, 'http://x/ard.png');
  assert.equal(ard.url, 'http://provider/ard.m3u8');
  assert.equal(ard.categoryId, 'News');

  // fallbacks: no tvg-id -> generated, no group -> Uncategorized
  const rtl = r.channels[2];
  assert.equal(rtl.id, 'idx-3');
  assert.equal(rtl.name, 'RTL');
  assert.equal(rtl.categoryName, 'Uncategorized');
});

test('parseM3U: duplicate tvg-ids become unique ids (stable per position)', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="dup",A',
    'http://p/a.m3u8',
    '#EXTINF:-1 tvg-id="dup",B',
    'http://p/b.m3u8',
  ].join('\n');
  const r = parseM3U(text);
  assert.notEqual(r.channels[0].id, r.channels[1].id);
  assert.equal(r.channels[0].id, 'dup');
  assert.match(r.channels[1].id, /^dup-/);
});

test('parseM3U: CRLF, blank lines, missing URLs and non-http lines are tolerated', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="x",X',
    'ftp://unsupported/x', // non-http -> skipped together with its EXTINF
    '',
    '#EXTINF:-1 tvg-id="y",Y\r',
    'http://p/y.m3u8',
    '#EXTINF:-1 tvg-id="z",Z', // dangling EXTINF without URL
  ].join('\r\n');
  const r = parseM3U(text);
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].id, 'y');
  assert.equal(r.channels[0].name, 'Y');
});

test('parseM3U: empty and garbage input produce empty results', () => {
  assert.deepEqual(parseM3U(''), { epgUrl: '', categories: [], channels: [] });
  assert.deepEqual(parseM3U(null), { epgUrl: '', categories: [], channels: [] });
  assert.equal(parseM3U('not a playlist').channels.length, 0);
});

// ------------------------------------------------------------ M3U adapter ----

test('M3UAdapter: authenticate validates playlist, caches, exposes stream URLs', async () => {
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    assert.equal(url, 'http://p/list.m3u8');
    return new Response(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="G",A\nhttp://p/a.m3u8\n',
      { status: 200, headers: { 'content-type': 'audio/x-mpegurl' } },
    );
  };
  const adapter = new M3UAdapter({ url: 'http://p/list.m3u8', fetchImpl });

  const auth = await adapter.authenticate();
  assert.equal(auth.ok, true);
  assert.equal(auth.channels, 1);

  const { channels } = await adapter.getChannels();
  assert.equal(channels.length, 1);
  assert.equal(adapter.getStreamUrl('a'), 'http://p/a.m3u8');
  assert.equal(adapter.getStreamUrl('missing'), null);
  assert.equal(fetches, 1, 'catalog is cached — no refetch');
  assert.equal(adapter.getEpgUrl(), null, 'no EPG URL given');
});

test('M3UAdapter: non-playlist response raises invalid_playlist', async () => {
  const fetchImpl = async () => new Response('<html>nope</html>', { status: 200 });
  const adapter = new M3UAdapter({ url: 'http://p/list.m3u8', fetchImpl });
  await assert.rejects(() => adapter.authenticate(), (e) => e.code === 'invalid_playlist');
});

test('M3UAdapter: http failure carries status', async () => {
  const fetchImpl = async () => new Response('nope', { status: 503 });
  const adapter = new M3UAdapter({ url: 'http://p/list.m3u8', fetchImpl });
  await assert.rejects(() => adapter.authenticate(), (e) => e.code === 'http_error' && e.status === 503);
});

// -------------------------------------------------------- Xtream adapter ----

function makeXtreamMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    calls.push(`${url.searchParams.get('action') || 'auth'}:${url.searchParams.get('username')}`);
    const send = (body, type = 'application/json') => {
      res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
      res.end(body);
    };
    if (!url.searchParams.get('action')) {
      const ok = url.searchParams.get('username') === 'user' && url.searchParams.get('password') === 'pass';
      return send(JSON.stringify({ user_info: { auth: ok ? 1 : 0, status: 'Active' } }));
    }
    const action = url.searchParams.get('action');
    if (action === 'get_live_categories') {
      return send(JSON.stringify([{ category_id: '1', category_name: 'News' }]));
    }
    if (action === 'get_live_streams') {
      return send(JSON.stringify([
        { stream_id: 10, num: 1, name: 'Chan A', stream_icon: 'http://x/a.png', category_id: '1', stream_type: 'live' },
        { stream_id: 11, num: 2, name: 'Chan B', category_id: '1', stream_type: 'live' },
        { stream_id: 12, num: 3, name: 'VOD entry', category_id: '1', stream_type: 'movie' }, // filtered out
        { stream_id: 13, num: 4, name: '##### 4K ᵁᴴᴰ ³⁸⁴⁰ᴾ #####', category_id: '1', stream_type: 'live' }, // header row
        { stream_id: 14, num: 5, name: '#### Sport Section', category_id: '1', stream_type: 'live' }, // header row
        { stream_id: 15, num: 6, name: 'Real Channel #1', category_id: '1', stream_type: 'live' }, // keep: # only mid-name
      ]));
    }
    if (action === 'get_short_epg') {
      const now = Math.floor(Date.now() / 1000);
      return send(JSON.stringify({
        epg_listings: [{ id: 'e1', title: 'Show', start: now, end: now + 600, start_timestamp: now, stop_timestamp: now + 600 }],
      }));
    }
    send('[]');
  });
  return { server, calls };
}

test('XtreamAdapter: authenticate, catalog mapping, EPG and stream URL over HTTP', async () => {
  const mock = makeXtreamMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${mock.server.address().port}`;
  const adapter = new XtreamAdapter({ host: `${host}/`, username: 'user', password: 'pass' });

  try {
    const auth = await adapter.authenticate();
    assert.equal(auth.ok, true);

    const { categories, channels } = await adapter.getChannels();
    assert.deepEqual(categories, [{ id: '1', name: 'News' }]);
    // movie entry + the two "#####" header rows are filtered;
    // "Real Channel #1" survives (hashes only mid-name)
    assert.equal(channels.length, 3);
    assert.equal(channels[0].id, '10');
    assert.equal(channels[0].name, 'Chan A');
    assert.equal(channels[0].logo, 'http://x/a.png');
    assert.equal(channels[0].categoryName, 'News');
    assert.ok(!channels.some((c) => c.name.includes('ᵁᴴᴰ')), 'header row dropped');
    assert.ok(!channels.some((c) => c.name === '#### Sport Section'), 'header prefix row dropped');
    assert.ok(channels.some((c) => c.name === 'Real Channel #1'), 'legit # in name kept');

    const url = adapter.getStreamUrl('10');
    assert.equal(url, `${host}/live/user/pass/10.m3u8`);

    const epg = await adapter.getEPG('10');
    assert.equal(epg.length, 1);
    assert.equal(epg[0].title, 'Show');

    // catalog caching: no additional category/stream fetches
    const callsAfterFirst = mock.calls.filter((c) => c.startsWith('get_')).length;
    await adapter.getChannels();
    const callsAfterSecond = mock.calls.filter((c) => c.startsWith('get_')).length;
    assert.equal(callsAfterSecond, callsAfterFirst, 'getChannels is cached');
  } finally {
    mock.server.close();
  }
});

test('XtreamAdapter: wrong credentials are rejected as invalid_credentials', async () => {
  const mock = makeXtreamMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${mock.server.address().port}`;
  const adapter = new XtreamAdapter({ host, username: 'user', password: 'wrong' });
  try {
    await assert.rejects(() => adapter.authenticate(), (e) => e.code === 'invalid_credentials');
  } finally {
    mock.server.close();
  }
});

test('XtreamAdapter: unreachable provider is classified as network_or_cors', async () => {
  const adapter = new XtreamAdapter({ host: 'http://127.0.0.1:1', username: 'u', password: 'p' });
  await assert.rejects(() => adapter.authenticate(), (e) => e.code === 'network_or_cors');
});

test('XtreamAdapter: slow links are classified as timeout, not network/CORS', async () => {
  const fetchImpl = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  await assert.rejects(
    () => adapter.authenticate(),
    (e) => e.code === 'timeout' && e.stage === 'Anmeldung' && /Zeitüberschreitung/.test(e.message),
  );
  await assert.rejects(
    () => adapter.getChannels(),
    (e) => e.code === 'timeout' && (e.stage === 'Kategorien' || e.stage === 'Senderliste'),
  );
});

test('XtreamAdapter: stageUrls exposes the real request sequence for diagnostics', () => {
  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p' });
  const stages = adapter.stageUrls();
  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map((s) => s.label), ['Anmeldung', 'Kategorien', 'Senderliste']);
  assert.ok(stages[0].url.includes('player_api.php'));
  assert.ok(!stages[0].url.includes('action='));
  assert.ok(stages[2].url.includes('action=get_live_streams'));
  assert.ok(stages.every((s) => typeof s.timeoutMs === 'number'));
  // the channel-list stage measures real download throughput
  assert.equal(stages[2].probeBytes, 262_144);
  assert.ok(stages[2].probeBudgetMs > 0);
});

test('XtreamAdapter: catalog download retries once on timeout/network failure', async () => {
  const mock = makeXtreamMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${mock.server.address().port}`;

  let streamsCalls = 0;
  const realFetch = fetch;
  const fetchImpl = async (url, opts) => {
    const u = new URL(String(url));
    if (u.searchParams.get('action') === 'get_live_streams' && !u.searchParams.get('category_id')) {
      streamsCalls += 1;
      if (streamsCalls === 1) {
        // first attempt: mid-transfer reset (TypeError like browsers report)
        throw new TypeError('Failed to fetch');
      }
    }
    return realFetch(url, opts);
  };

  const adapter = new XtreamAdapter({ host, username: 'user', password: 'pass', fetchImpl });
  try {
    await adapter.authenticate();
    const catalog = await adapter.getChannels();
    assert.equal(catalog.channels.length, 3); // retry rescued the catalog
    assert.equal(catalog.partial, false); // fallback never ran
    assert.equal(streamsCalls, 2, 'exactly one retry');
  } finally {
    mock.server.close();
  }
});

const jsonResponse = (data) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('XtreamAdapter: full-list failure falls back to per-category loading', async () => {
  const cats = [
    { category_id: '1', category_name: 'A' },
    { category_id: '2', category_name: 'B' },
  ];
  const byCat = {
    '1': [
      { stream_id: 10, name: 'Chan A', category_id: '1', stream_type: 'live' },
      { stream_id: 11, name: 'Chan B', category_id: '1', stream_type: 'live' },
    ],
    '2': [
      // stream 10 delivered by two categories -> must be deduped
      { stream_id: 10, name: 'Chan A', category_id: '2', stream_type: 'live' },
      { stream_id: 12, name: 'Chan C', category_id: '2', stream_type: 'live' },
    ],
  };
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') return jsonResponse(cats);
    if (action === 'get_live_streams') {
      const cat = u.searchParams.get('category_id');
      if (!cat) throw new TypeError('Failed to fetch'); // the big transfer always dies
      return jsonResponse(byCat[cat] || []);
    }
    return jsonResponse({ user_info: { auth: 1 } });
  };

  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  const progress = [];
  const catalog = await adapter.getChannels((done, total, failed) => progress.push([done, total, failed]));

  assert.equal(catalog.partial, true);
  assert.equal(catalog.failedCategories, 0);
  assert.equal(catalog.channels.length, 3, 'duplicate stream ids deduped');
  assert.deepEqual(catalog.channels.map((c) => c.id).sort(), ['10', '11', '12']);
  assert.equal(catalog.categories.length, 2);
  assert.deepEqual(progress[progress.length - 1], [2, 2, 0], 'progress reached the end');
});

test('XtreamAdapter: failed categories are tolerated and counted', async () => {
  const cats = [
    { category_id: '1', category_name: 'A' },
    { category_id: '2', category_name: 'B' },
    { category_id: '3', category_name: 'C' },
  ];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') return jsonResponse(cats);
    if (action === 'get_live_streams') {
      const cat = u.searchParams.get('category_id');
      if (!cat) throw new TypeError('Failed to fetch'); // full list dies
      if (cat === '2') throw new TypeError('Failed to fetch'); // this category always dies, too
      return jsonResponse([{ stream_id: cat === '1' ? 10 : 12, name: 'C', category_id: cat, stream_type: 'live' }]);
    }
    return jsonResponse({ user_info: { auth: 1 } });
  };

  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  const catalog = await adapter.getChannels();
  assert.equal(catalog.partial, true);
  assert.equal(catalog.failedCategories, 1);
  assert.deepEqual(catalog.channels.map((c) => c.id).sort(), ['10', '12']);
});

test('XtreamAdapter: per-category fallback stops when cancelled', async () => {
  let categoryCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      return jsonResponse([{ category_id: '1', category_name: 'A' }]);
    }
    if (action === 'get_live_streams') {
      if (!u.searchParams.get('category_id')) throw new TypeError('Failed to fetch');
      categoryCalls += 1;
      return jsonResponse([{ stream_id: categoryCalls, name: 'C', category_id: '1', stream_type: 'live' }]);
    }
    return jsonResponse({ user_info: { auth: 1 } });
  };

  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  const catalog = await adapter.getChannels(undefined, () => true); // cancelled from the start
  assert.equal(catalog.partial, true);
  assert.equal(categoryCalls, 0, 'no category request after cancellation');
  assert.equal(catalog.channels.length, 0);
});

test('XtreamAdapter: everything failing resolves to an empty partial catalog (no throw)', async () => {
  let streamsCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('action') === 'get_live_streams') {
      streamsCalls += 1;
      throw new TypeError('Failed to fetch'); // full AND per-category all fail
    }
    if (u.searchParams.get('action') === 'get_live_categories') {
      return jsonResponse([{ category_id: '1', category_name: 'News' }]);
    }
    return jsonResponse({ user_info: { auth: 1 } });
  };

  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  const catalog = await adapter.getChannels();
  assert.equal(catalog.channels.length, 0);
  assert.equal(catalog.partial, true);
  assert.equal(catalog.failedCategories, 1);
  assert.equal(streamsCalls, 5, '2 full attempts + 3 category attempts');

  // Empty catalogs are never cached — the next call retries from scratch.
  const before = streamsCalls;
  const again = await adapter.getChannels();
  assert.equal(again.channels.length, 0);
  assert.ok(streamsCalls > before, 'second getChannels re-attempted the catalog');
});

test('XtreamAdapter: small requests (auth/categories) retry through transient blips', async () => {
  let authCalls = 0;
  let catCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (!u.searchParams.get('action')) {
      authCalls += 1;
      if (authCalls === 1) throw new TypeError('Failed to fetch'); // transient
      return jsonResponse({ user_info: { auth: 1 } });
    }
    if (u.searchParams.get('action') === 'get_live_categories') {
      catCalls += 1;
      if (catCalls <= 2) throw new TypeError('Failed to fetch'); // two blips
      return jsonResponse([{ category_id: '1', category_name: 'A' }]);
    }
    return jsonResponse([]);
  };
  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  await adapter.authenticate(); // survives the first-call blip
  const cats = await adapter.getCategories(); // survives two blips
  assert.equal(cats.length, 1);
  assert.equal(authCalls, 2);
  assert.equal(catCalls, 3);
});

test('XtreamAdapter: small-request retries stop after three attempts', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  };
  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  await assert.rejects(() => adapter.authenticate(), (e) => e.code === 'network_or_cors');
  assert.equal(calls, 3, 'three attempts, then the error surfaces');
});

test('XtreamAdapter: per-category fallback stays at low concurrency', async () => {
  const cats = Array.from({ length: 8 }, (_, i) => ({ category_id: String(i), category_name: `C${i}` }));
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const action = u.searchParams.get('action');
    if (action === 'get_live_streams' && !u.searchParams.get('category_id')) {
      throw new TypeError('Failed to fetch'); // big transfer always dies
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 25));
    inFlight -= 1;
    if (action === 'get_live_categories') return jsonResponse(cats);
    const cid = u.searchParams.get('category_id');
    return jsonResponse([{ stream_id: cid, name: 'C', category_id: cid, stream_type: 'live' }]);
  };
  const adapter = new XtreamAdapter({ host: 'http://p.example', username: 'u', password: 'p', fetchImpl });
  const catalog = await adapter.getChannels();
  assert.equal(catalog.channels.length, 8);
  assert.equal(catalog.partial, true);
  assert.ok(maxInFlight <= 2, `max concurrent provider requests was ${maxInFlight}, must stay <= 2 (max_connections=1 accounts)`);
});

test('XtreamAdapter: credentials are URL-encoded in stream URLs', () => {
  const adapter = new XtreamAdapter({ host: 'http://p:8080', username: 'u ser/x', password: 'pä:s?' });
  assert.equal(
    adapter.getStreamUrl('10'),
    'http://p:8080/live/u%20ser%2Fx/p%C3%A4%3As%3F/10.m3u8',
  );
});

// ------------------------------------------------------------- XMLTV EPG -----

test('parseXMLTV: channels, programmes, entity decoding, window filter', () => {
  const nowRef = Date.UTC(2026, 8, 9, 0, 30, 0); // 2026-09-09 00:30Z
  const sec = (s) => Math.floor(nowRef / 1000) + s;
  const xml = `<?xml version="1.0"?><tv>
    <channel id="ard.de"><display-name>ARD &amp; friends</display-name></channel>
    <programme start="20260909000000 +0000" stop="20260909010000 +0000" channel="ard.de">
      <title><![CDATA[Tagesschau]]></title><desc>News show</desc>
    </programme>
    <programme start="20260909010000 +0000" stop="20260909020000 +0000" channel="ard.de">
      <title>Nachtmagazin</title>
    </programme>
    <programme start="20260901000000 +0000" stop="20260901010000 +0000" channel="ard.de">
      <title>Long past — must be dropped</title>
    </programme>
  </tv>`;
  const parsed = parseXMLTV(xml, nowRef);
  assert.equal(parsed.channelNames.get('ard.de'), 'ARD & friends');
  const list = parsed.byChannel.get('ard.de');
  assert.equal(list.length, 2, 'long-past programme dropped');

  const short = shortEpg(parsed, 'ard.de', { nowRef });
  assert.equal(short[0].title, 'Tagesschau');
  assert.equal(short[0].start, sec(-1800));
  assert.equal(short[0].end, sec(1800));
  assert.equal(short[1].title, 'Nachtmagazin');

  // end-less programmes are never dropped by the "past" filter
  const openEnd = parseXMLTV(
    `<?xml version="1.0"?><tv><programme start="19700101000000 +0000" channel="ard.de"><title>Since forever</title></programme></tv>`,
    nowRef,
  );
  assert.equal(shortEpg(openEnd, 'ard.de', { nowRef })[0].title, 'Since forever');

  assert.deepEqual(shortEpg(parsed, 'unknown'), []);
});

test('parseXmltvTime: offsets are converted to UTC epochs', () => {
  // 2026-09-09 12:00:00 +02:00 == 2026-09-09 10:00:00Z
  assert.equal(parseXmltvTime('20260909120000 +0200'), Date.UTC(2026, 8, 9, 10) / 1000);
  // no offset is treated as UTC
  assert.equal(parseXmltvTime('20260909120000'), Date.UTC(2026, 8, 9, 12) / 1000);
  assert.equal(parseXmltvTime('garbage'), null);
  assert.equal(parseXmltvTime(''), null);
});

test('fetchXmltv: transparently decompresses gzip responses', async () => {
  const xml = '<?xml version="1.0"?><tv><channel id="x"><display-name>X</display-name></channel></tv>';
  const gz = zlib.gzipSync(Buffer.from(xml, 'utf8'));
  const fetchImpl = async () =>
    new Response(gz, { status: 200, headers: { 'content-type': 'application/gzip' } });
  const text = await fetchXmltv('http://epg/guide.xml.gz', { fetchImpl });
  assert.ok(text.includes('<channel id="x">'));

  // .gz URL suffix triggers decompression even without content-type
  const fetchImpl2 = async () => new Response(gz, { status: 200 });
  const text2 = await fetchXmltv('http://epg/guide.xml.gz', { fetchImpl: fetchImpl2 });
  assert.ok(text2.includes('<channel id="x">'));
});

// ------------------------------------------------------------ profiles ------
// (localStorage does not exist in Node — the store must degrade gracefully.)

test('profile store degrades safely without localStorage', async () => {
  const profiles = await import('../public/js/profiles.js');
  assert.deepEqual(profiles.loadProfiles(), []);
  profiles.saveProfiles([{ id: 'a', type: 'xtream', name: 'A', host: 'http://a' }]);
  assert.deepEqual(profiles.loadProfiles(), [], 'write is a no-op without storage');
  assert.equal(profiles.getRememberedSecret('a'), null);
  assert.deepEqual([...profiles.getFavorites('a')], []);
  assert.deepEqual(profiles.getRecent('a'), []);
  profiles.pushRecent('a', { id: 'c1', name: 'Chan' }); // must not throw
  assert.equal(profiles.getProfile('a'), null);
});
