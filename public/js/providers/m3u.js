// M3U / M3U8 playlist support. Parsing is pure (no DOM, no fetch) so it is
// unit-testable in Node and usable in the browser.
//
// Channel identity: tvg-id when present, otherwise a stable generated id.
// Categories come from group-title. EPG mapping uses the tvg-id.

const CHANNEL_CACHE_MS = 60_000;

export function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];
  const categoryMap = new Map();
  const seenIds = new Set();
  let pending = null;
  let epgUrl = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.toUpperCase().startsWith('#EXTM3U')) {
      const m = line.match(/(?:x-tvg-url|url-tvg)\s*=\s*"([^"]+)"/i);
      if (m) epgUrl = m[1];
      continue;
    }

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const attrs = {};
      const commaIdx = line.indexOf(',');
      const attrPart = commaIdx === -1 ? line : line.slice(0, commaIdx);
      const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(attrPart))) {
        attrs[am[1].toLowerCase()] = am[2];
      }
      const name = commaIdx === -1 ? '' : line.slice(commaIdx + 1).trim();
      pending = { attrs, name };
      continue;
    }

    if (line.startsWith('#')) continue; // #EXTGRP, #EXTVLCOPT, comments…

    if (!/^https?:\/\//i.test(line)) {
      pending = null; // unreachable / unsupported line
      continue;
    }

    const p = pending || { attrs: {}, name: '' };
    pending = null;
    const n = channels.length + 1;

    const groupName = (p.attrs['group-title'] || 'Uncategorized').trim() || 'Uncategorized';
    if (!categoryMap.has(groupName)) categoryMap.set(groupName, { id: groupName, name: groupName });

    let id = (p.attrs['tvg-id'] || '').trim() || `idx-${n}`;
    if (seenIds.has(id)) id = `${id}-${n}`;
    seenIds.add(id);

    channels.push({
      id,
      num: n,
      name: p.name || (p.attrs['tvg-name'] || '').trim() || `Channel ${n}`,
      logo: (p.attrs['tvg-logo'] || '').trim(),
      url: line,
      categoryId: groupName,
      categoryName: groupName,
      tvgId: (p.attrs['tvg-id'] || '').trim(),
    });
  }

  return {
    epgUrl,
    categories: [...categoryMap.values()],
    channels,
  };
}

/** M3U profile adapter: fetch-once catalog, optional XMLTV EPG, direct URLs. */
export class M3UAdapter {
  constructor({ url, epgUrl, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.url = String(url || '');
    this.epgUrl = epgUrl || '';
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.catalog = null; // { at, data, inflight }
  }

  async fetchText(url) {
    // Bounded request (AbortSignal.timeout: modern browsers; older skip).
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(12_000)
        : undefined;
    const res = await this.fetchImpl(url, {
      headers: { accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*' },
      signal,
    });
    if (!res.ok) {
      const err = new Error(`Playlist request failed (HTTP ${res.status})`);
      err.code = 'http_error';
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    if (!/^\uFEFF?#EXTM3U/i.test(text.trim())) {
      const err = new Error('URL did not return an M3U/M3U8 playlist');
      err.code = 'invalid_playlist';
      throw err;
    }
    return text;
  }

  async authenticate() {
    // A successful fetch + parse is the M3U "authentication".
    const { channels } = await this.getChannels();
    return { ok: true, channels: channels.length };
  }

  getChannelsCached() {
    if (this.catalog && this.catalog.data && this.now() - this.catalog.at < CHANNEL_CACHE_MS) {
      return this.catalog.data;
    }
    if (this.catalog && this.catalog.inflight) return this.catalog.inflight;
    this.catalog = { ...this.catalog, inflight: null };
    const load = (async () => {
      const text = await this.fetchText(this.url);
      const data = parseM3U(text);
      if (!data.epgUrl && this.epgUrl) data.epgUrl = this.epgUrl;
      this.catalog = { at: this.now(), data, inflight: null };
      return data;
    })();
    this.catalog.inflight = load;
    return load;
  }

  async getChannels() {
    return this.getChannelsCached();
  }

  async getCategories() {
    const { categories } = await this.getChannels();
    return categories;
  }

  getStreamUrl(channelId) {
    if (!this.catalog || !this.catalog.data) return null;
    const ch = this.catalog.data.channels.find((c) => c.id === channelId);
    return ch ? ch.url : null;
  }

  getEpgUrl() {
    if (!this.catalog || !this.catalog.data) return this.epgUrl || null;
    return this.catalog.data.epgUrl || this.epgUrl || null;
  }

  disconnect() {
    this.catalog = null;
  }
}
