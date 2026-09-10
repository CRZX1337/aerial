// XMLTV EPG support for M3U profiles. Parser is regex/tokenizer based (no
// DOMParser) so it works in the browser AND in Node tests. Gzip files are
// transparently decompressed via DecompressionStream when the browser/Node
// provides it.

const XMLTV_EPG_WINDOW_MS = 12 * 60 * 60 * 1000; // keep +/- 12h around now

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** XMLTV timestamps: "YYYYMMDDHHMMSS +HHMM" (offset optional). */
export function parseXmltvTime(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, sign, oh, om] = m;
  let epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  if (sign) {
    const offsetMs = (Number(oh) * 60 + Number(om)) * 60 * 1000;
    epoch += sign === '+' ? -offsetMs : offsetMs;
  }
  return Math.floor(epoch / 1000);
}

function attrsOf(tagText) {
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagText))) attrs[m[1].toLowerCase()] = decodeEntities(m[2]);
  return attrs;
}

function firstTag(inner, tag) {
  const m = inner.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1].replace(/<\!\[CDATA\[|\]\]>/g, '').trim()) : '';
}

/**
 * Parses XMLTV into a channel map + per-channel sorted programme lists
 * (already trimmed to the EPG window around `nowRef` when given).
 */
export function parseXMLTV(text, nowRef) {
  const nowSec = nowRef !== undefined ? Math.floor(nowRef / 1000) : Math.floor(Date.now() / 1000);
  const channelNames = new Map();
  const byChannel = new Map();

  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let cm;
  while ((cm = channelRe.exec(text))) {
    const attrs = attrsOf(cm[1]);
    if (attrs.id) {
      const name = firstTag(cm[2], 'display-name');
      channelNames.set(attrs.id, name || attrs.id);
      if (!byChannel.has(attrs.id)) byChannel.set(attrs.id, []);
    }
  }

  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let pm;
  while ((pm = programmeRe.exec(text))) {
    const attrs = attrsOf(pm[1]);
    const channelId = attrs.channel;
    const start = parseXmltvTime(attrs.start);
    const stop = parseXmltvTime(attrs.stop);
    if (!channelId || start === null) continue;
    if (stop !== null && stop < nowSec - 900) continue; // long past
    if (start > nowSec + XMLTV_EPG_WINDOW_MS / 1000) continue; // far future
    const list = byChannel.get(channelId) || [];
    list.push({
      id: `${channelId}@${start}`,
      title: firstTag(pm[2], 'title') || '—',
      description: firstTag(pm[2], 'desc'),
      start,
      end: stop,
      startTimestamp: start,
      stopTimestamp: stop,
    });
    byChannel.set(channelId, list);
  }

  for (const list of byChannel.values()) list.sort((a, b) => a.start - b.start);
  return { channelNames, byChannel };
}

/** Short EPG for one channel: current + upcoming programmes. */
export function shortEpg(parsed, channelId, opts = {}) {
  if (!parsed) return [];
  const limit = typeof opts === 'number' ? opts : (opts.limit ?? 6);
  const nowSec =
    opts && typeof opts.nowRef === 'number'
      ? Math.floor(opts.nowRef / 1000)
      : Math.floor(Date.now() / 1000);
  const list = parsed.byChannel.get(channelId) || [];
  const out = [];
  for (const p of list) {
    if (p.end !== null && p.end < nowSec) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Fetch an XMLTV URL (optionally .gz) and return the XML text. */
export async function fetchXmltv(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/xml, text/xml, */*' } });
  if (!res.ok) {
    const err = new Error(`EPG request failed (HTTP ${res.status})`);
    err.code = 'http_error';
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  const looksGz = /\.gz($|\?)/i.test(url) || /gzip/i.test(ct);
  if (looksGz) {
    if (typeof DecompressionStream === 'undefined') {
      const err = new Error('Gzip-EPG is not supported in this browser');
      err.code = 'epg_gzip_unsupported';
      throw err;
    }
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return await res.text();
}
