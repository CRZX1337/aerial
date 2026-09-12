// Xtream Codes API adapter — runs IN THE BROWSER and talks to the user's
// own provider directly. Credentials live in this instance (memory) and are
// never sent anywhere except to that provider.
//
// Browser compatibility caveat (CORS): many Xtream panels send
// Access-Control-Allow-Origin: * on player_api.php and /live/, which makes
// direct browser usage work. Panels without CORS headers cannot be used
// from a browser — the adapter surfaces a clear error instead of silently
// routing through a proxy.

const CHANNEL_CACHE_MS = 60_000;
const EPG_CACHE_MS = 30_000;

export class XtreamAdapter {
  constructor({ host, username, password, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.host = String(host || '').replace(/\/+$/, '');
    this.username = String(username || '');
    this.password = String(password || '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.channelsCache = { data: null, at: 0, inflight: null };
    this.epgCache = new Map(); // streamId -> { data, at, inflight }
  }

  get configured() {
    return Boolean(this.host && this.username && this.password);
  }

  playerApi(action, extra) {
    const u = new URL(`${this.host}/player_api.php`);
    u.searchParams.set('username', this.username);
    u.searchParams.set('password', this.password);
    if (action) u.searchParams.set('action', action);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async fetchJson(url) {
    let res;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      const e = new Error('Provider unreachable (network or CORS)');
      e.code = 'network_or_cors';
      e.cause = err;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`Provider request failed (HTTP ${res.status})`);
      e.code = 'http_error';
      e.status = res.status;
      throw e;
    }
    try {
      return await res.json();
    } catch {
      const e = new Error('Provider returned invalid JSON');
      e.code = 'invalid_response';
      throw e;
    }
  }

  async authenticate() {
    // No action returns user_info — the canonical credential check.
    const data = await this.fetchJson(this.playerApi(null));
    const info = data && data.user_info;
    const ok = Boolean(info && (info.auth === 1 || info.auth === '1' || info.auth === true));
    if (!ok) {
      const e = new Error('Provider rejected the credentials');
      e.code = 'invalid_credentials';
      throw e;
    }
    return { ok: true, info: { status: info.status, expDate: info.exp_date } };
  }

  singleFlight(holder, ttlMs, loader) {
    if (holder.data && this.now() - holder.at < ttlMs) return holder.data;
    if (holder.inflight) return holder.inflight;
    holder.inflight = loader()
      .then((data) => {
        holder.data = data;
        holder.at = this.now();
        return data;
      })
      .finally(() => {
        holder.inflight = null;
      });
    return holder.inflight;
  }

  async getChannels() {
    return this.singleFlight(this.channelsCache, CHANNEL_CACHE_MS, async () => {
      const [categories, streams] = await Promise.all([
        this.fetchJson(this.playerApi('get_live_categories')).then((d) => (Array.isArray(d) ? d : [])),
        this.fetchJson(this.playerApi('get_live_streams')).then((d) => (Array.isArray(d) ? d : [])),
      ]);
      const catName = new Map();
      for (const c of categories) {
        if (c && c.category_id != null) catName.set(String(c.category_id), c.category_name);
      }
      // Some panels pad the stream list with "header" rows (e.g.
      // "##### 4K UHD #####") that are not real channels — drop them.
      const isHeaderRow = (name) =>
        typeof name === 'string' &&
        (/^#{3,}[\s\S]*#{3,}$/.test(name.trim()) || /^#{4,}/.test(name.trim()) || /^#+$/.test(name.trim()));
      const channels = streams
        .filter((s) => s && s.stream_id != null && (s.stream_type === 'live' || s.stream_type == null))
        .filter((s) => !isHeaderRow(s.name))
        .map((s, i) => ({
          id: String(s.stream_id),
          num: s.num || i + 1,
          name: s.name || `Channel ${s.stream_id}`,
          logo: s.stream_icon || '',
          categoryId: s.category_id != null ? String(s.category_id) : '',
          categoryName: catName.get(String(s.category_id)) || 'Uncategorized',
          epgChannelId: s.epg_channel_id || '',
          tvgId: s.epg_channel_id || '',
        }));
      const ordered = categories
        .filter((c) => c && c.category_id != null)
        .map((c) => ({ id: String(c.category_id), name: c.category_name }));
      return { categories: ordered, channels };
    });
  }

  async getCategories() {
    const { categories } = await this.getChannels();
    return categories;
  }

  /** Direct HLS playlist URL at the provider (native HLS & hls.js). */
  getStreamUrl(channelId) {
    if (!this.configured) return null;
    return `${this.host}/live/${encodeURIComponent(this.username)}/${encodeURIComponent(this.password)}/${encodeURIComponent(String(channelId))}.m3u8`;
  }

  async getEPG(streamId, limit = 8) {
    const key = String(streamId);
    const holder = this.epgCache.get(key) || { data: null, at: 0, inflight: null };
    this.epgCache.set(key, holder);
    return this.singleFlight(holder, EPG_CACHE_MS, async () => {
      const data = await this.fetchJson(
        this.playerApi('get_short_epg', { stream_id: String(streamId), limit: String(limit) }),
      );
      return (data && Array.isArray(data.epg_listings) ? data.epg_listings : []).map((e) => ({
        id: e.id,
        title: e.title || '',
        description: e.description || '',
        start: e.start ? Number(e.start) : null,
        end: e.end ? Number(e.end) : null,
        startTimestamp: e.start_timestamp ? Number(e.start_timestamp) : null,
        stopTimestamp: e.stop_timestamp ? Number(e.stop_timestamp) : null,
      }));
    });
  }

  disconnect() {
    this.channelsCache = { data: null, at: 0, inflight: null };
    this.epgCache = new Map();
  }
}
