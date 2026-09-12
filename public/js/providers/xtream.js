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

/** Small fixed-concurrency pool — used for per-category catalog loading. */
async function mapPool(total, limit, worker) {
  const remaining = { count: total };
  const lanes = Math.max(1, Math.min(limit, total));
  const runners = Array.from({ length: lanes }, async () => {
    while (remaining.count > 0) {
      remaining.count -= 1;
      const index = total - remaining.count - 1;
      await worker(index);
    }
  });
  await Promise.all(runners);
}

export class XtreamAdapter {
  constructor({ host, username, password, fetchImpl, now = () => Date.now() } = {}) {
    this.host = String(host || '').replace(/\/+$/, '');
    this.username = String(username || '');
    this.password = String(password || '');
    // fetchImpl may be a direct fetch or the server-relay fetch
    // (see providers/relayfetch.js) — the adapter code is agnostic.
    this.fetchImpl = fetchImpl || fetch;
    this.now = now;
    this.channelsCache = { data: null, at: 0, inflight: null };
    this.categoriesCache = { data: null, at: 0, inflight: null };
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

  async fetchJson(url, timeoutMs = 15_000, stage = '') {
    // Bounded request: hung/slow connections must surface as a typed error
    // instead of spinning forever. Catalog requests pass a much larger
    // budget (20+ MB lists are legitimate). AbortSignal.timeout: Safari
    // 16+, Chrome 103+, Firefox 100+ — older browsers simply skip the limit.
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    let res;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        // Slow link (huge catalog on mobile) — NOT a network/CORS problem.
        const e = new Error(`Zeitüberschreitung bei „${stage || 'Anbieter-Anfrage'}"`);
        e.code = 'timeout';
        e.stage = stage;
        throw e;
      }
      const e = new Error('Provider unreachable (network or CORS)');
      e.code = 'network_or_cors';
      e.stage = stage;
      e.cause = err;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`Provider request failed (HTTP ${res.status})`);
      e.code = 'http_error';
      e.status = res.status;
      e.stage = stage;
      throw e;
    }
    try {
      return await res.json();
    } catch {
      const e = new Error('Provider returned invalid JSON');
      e.code = 'invalid_response';
      e.stage = stage;
      throw e;
    }
  }

  /**
   * Small request with bounded retries — CDN-fronted provider edges are
   * intermittently flaky: a single dropped auth/categories request must not
   * fail the whole connect. Non-transport errors (bad credentials, HTTP
   * errors) surface immediately without retries.
   */
  async fetchJsonRetry(url, timeoutMs, stage, attempts = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.fetchJson(url, timeoutMs, stage);
      } catch (err) {
        lastErr = err;
        if (err.code !== 'timeout' && err.code !== 'network_or_cors') throw err;
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  async authenticate() {
    // No action returns user_info — the canonical credential check.
    const data = await this.fetchJsonRetry(this.playerApi(null), 15_000, 'Anmeldung');
    const info = data && data.user_info;
    const ok = Boolean(info && (info.auth === 1 || info.auth === '1' || info.auth === true));
    if (!ok) {
      const e = new Error('Provider rejected the credentials');
      e.code = 'invalid_credentials';
      e.stage = 'Anmeldung';
      throw e;
    }
    return { ok: true, info: { status: info.status, expDate: info.exp_date } };
  }

  /** Real request URLs for staged connection diagnostics. */
  stageUrls() {
    return [
      { label: 'Anmeldung', url: this.playerApi(null), timeoutMs: 15_000 },
      { label: 'Kategorien', url: this.playerApi('get_live_categories'), timeoutMs: 60_000 },
      {
        label: 'Senderliste',
        url: this.playerApi('get_live_streams'),
        timeoutMs: 90_000,
        // Read 256 KB of the real channel list to measure the actual
        // download throughput (headers alone hide slow links).
        probeBytes: 262_144,
        probeBudgetMs: 30_000,
      },
    ];
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

  /** Category list (small request, cached separately from the catalog). */
  async getCategories() {
    return this.singleFlight(this.categoriesCache, CHANNEL_CACHE_MS, async () => {
      const data = await this.fetchJsonRetry(this.playerApi('get_live_categories'), 60_000, 'Kategorien');
      return (Array.isArray(data) ? data : [])
        .filter((c) => c && c.category_id != null)
        .map((c) => ({ id: String(c.category_id), name: c.category_name }));
    });
  }

  /** Shared catalog mapping: header-row filter + per-id dedupe. */
  buildCatalog(mappedCategories, streams) {
    const catName = new Map();
    for (const c of mappedCategories) catName.set(c.id, c.name);
    // Some panels pad the stream list with "header" rows (e.g.
    // "##### 4K UHD #####") that are not real channels — drop them.
    const isHeaderRow = (name) =>
      typeof name === 'string' &&
      (/^#{3,}[\s\S]*#{3,}$/.test(name.trim()) || /^#{4,}/.test(name.trim()) || /^#+$/.test(name.trim()));
    const seen = new Set();
    const channels = [];
    for (const s of streams) {
      if (!s || s.stream_id == null) continue;
      if (s.stream_type !== 'live' && s.stream_type != null) continue;
      if (isHeaderRow(s.name)) continue;
      const id = String(s.stream_id);
      if (seen.has(id)) continue; // per-category results may overlap
      seen.add(id);
      channels.push({
        id,
        num: s.num || channels.length + 1,
        name: s.name || `Channel ${s.stream_id}`,
        logo: s.stream_icon || '',
        categoryId: s.category_id != null ? String(s.category_id) : '',
        categoryName: catName.get(String(s.category_id)) || 'Uncategorized',
        epgChannelId: s.epg_channel_id || '',
        tvgId: s.epg_channel_id || '',
      });
    }
    return { categories: mappedCategories, channels };
  }

  /**
   * Full channel list as ONE large transfer (20+ MB on big providers).
   * Two attempts — mid-transfer resets are common on long downloads.
   */
  async fetchFullStreams() {
    const url = this.playerApi('get_live_streams');
    let lastErr = null;
    for (const budgetMs of [120_000, 180_000]) {
      try {
        const data = await this.fetchJson(url, budgetMs, 'Senderliste');
        return Array.isArray(data) ? data : [];
      } catch (err) {
        lastErr = err;
        if (err.code !== 'timeout' && err.code !== 'network_or_cors') throw err;
      }
    }
    throw lastErr;
  }

  /**
   * Per-category fallback: instead of one huge transfer, fetch every
   * category's streams separately (get_live_streams&category_id=X —
   * ~20 KB each). Small requests survive unstable routes and flaky
   * provider edges that repeatedly kill a 20 MB download.
   *
   * Concurrency deliberately LOW (2): many IPTV accounts allow only one
   * or two parallel connections (max_connections=1 is common) — aggressive
   * pools get throttled or killed by the panel. Each category gets three
   * attempts with short backoff; individual failures are tolerated.
   */
  async fetchStreamsByCategory(categories, onProgress, isCancelled) {
    const collected = [];
    const total = categories.length;
    const state = { done: 0, failed: 0, cancelled: false };
    await mapPool(total, 2, async (index) => {
      if (state.cancelled) return;
      if (isCancelled && isCancelled()) {
        state.cancelled = true;
        return;
      }
      const cat = categories[index];
      let streams = null;
      for (let attempt = 0; attempt < 3 && streams === null; attempt++) {
        try {
          const data = await this.fetchJson(
            this.playerApi('get_live_streams', { category_id: cat.id }),
            30_000,
            `Kategorie ${cat.name || cat.id}`,
          );
          streams = Array.isArray(data) ? data : [];
        } catch {
          streams = null; // retry with backoff, then give up on this category
        }
        if (streams === null && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      state.done += 1;
      if (streams === null) state.failed += 1;
      else collected.push(...streams);
      if (onProgress) {
        try {
          onProgress(state.done, total, state.failed);
        } catch { /* progress is best-effort */ }
      }
    });
    return { streams: collected, failed: state.failed, cancelled: state.cancelled };
  }

  /**
   * Catalog: categories + channel list. Resilient by design —
   *  1. one big get_live_streams (two attempts)
   *  2. if that keeps failing: per-category fallback (many small,
   *     individually retried requests) with progress reporting
   * Returns { categories, channels, partial, failedCategories }.
   */
  async getChannels(onProgress, isCancelled) {
    return this.singleFlight(this.channelsCache, CHANNEL_CACHE_MS, async () => {
      const categories = await this.getCategories();
      let streams;
      let partial = false;
      let failedCategories = 0;
      try {
        streams = await this.fetchFullStreams();
      } catch {
        const fallback = await this.fetchStreamsByCategory(categories, onProgress, isCancelled);
        streams = fallback.streams;
        partial = true;
        failedCategories = fallback.failed;
      }
      const catalog = this.buildCatalog(categories, streams);
      catalog.partial = partial;
      catalog.failedCategories = failedCategories;
      if (catalog.channels.length === 0) {
        // Never cache an empty catalog — the next attempt must retry
        // instead of serving the failure from cache.
        this.channelsCache = { data: null, at: 0, inflight: null };
      }
      return catalog;
    });
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
        15_000,
        'EPG',
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
    this.categoriesCache = { data: null, at: 0, inflight: null };
    this.epgCache = new Map();
  }
}
