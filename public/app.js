import { XtreamAdapter } from './js/providers/xtream.js?v=11';
import { M3UAdapter } from './js/providers/m3u.js?v=11';
import { fetchXmltv, parseXMLTV, shortEpg } from './js/providers/xmltv.js?v=11';
import { diagnoseStages, httpsTwin } from './js/providers/netcheck.js?v=11';
import {
  loadProfiles,
  upsertProfile,
  deleteProfile,
  getProfile,
  getActiveProfileId,
  setActiveProfileId,
  newProfileId,
  getRememberedSecret,
  setRememberedSecret,
  getFavorites,
  saveFavorites,
  getRecent,
  pushRecent,
} from './js/profiles.js?v=11';

(function () {
  'use strict';

  // ------------------------------------------------------------------ state --
  let role = null;
  let profiles = [];
  let activeProfileId = null;
  let adapter = null; // XtreamAdapter | M3UAdapter of the active profile
  let memorySecret = null; // provider password for the session (not persisted)
  let channels = [];
  let categories = [];
  let favorites = new Set();
  let recent = [];
  let search = '';
  let activeCategory = 'all';
  let favOnly = false;
  let loadingChannels = false;
  let connectToken = 0; // provider-connect race guard
  let currentChannel = null;
  let lastEpg = null; // { channelId, list, fetchedAt }
  let catalogError = null;

  // --- player robustness state ---
  let hls = null;
  let autoplayBlocked = false;
  let userInteracted = false;
  let userPaused = false;
  let recoveryAttempts = 0;
  let recoveryPending = false;
  let recoveryTimer = null;
  let stallTimer = null;
  let playerErrorKind = null;
  let mediaSessionActionsBound = false;
  let lastMediaSessionChannelId = null;
  let lastLifecycleSync = 0;
  let lastRenderedActiveId = '__none__';
  let epgReq = 0;
  let xmltvParsed = null; // parsed XMLTV for M3U profiles
  let xmltvFetchedAt = 0;

  // --- windowed channel list (huge catalogs: 50k+ channels) ---
  let listVersion = 0; // bumped whenever the catalog data changes
  let renderLimit = 0; // how many filtered channels are currently rendered
  let renderedSignature = null; // last rendered filter signature
  let listObserver = null; // IntersectionObserver for infinite scroll
  let searchDebounce = null;
  let categoriesSignature = null;

  const PAGE_INITIAL = 90;
  const PAGE_STEP = 150;

  const MAX_RECOVERY_ATTEMPTS = 5;
  const XMLTV_REFRESH_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    loginView: $('login-view'),
    onboardView: $('onboard-view'),
    unlockView: $('unlock-view'),
    appView: $('app-view'),
    tabbar: $('tabbar'),
    roleBadge: $('role-badge'),
    logoutBtn: $('logout-btn'),
    connDot: $('conn-dot'),
    video: $('video'),
    offline: $('offline'),
    liveBadge: $('live-badge'),
    profileChip: $('profile-chip'),
    channelTitle: $('channel-title'),
    channelMeta: $('channel-meta'),
    switchBtn: $('switch-btn'),
    epgPanel: $('epg-panel'),
    epgNowTitle: $('epg-now-title'),
    epgNowTime: $('epg-now-time'),
    epgNext: $('epg-next'),
    guideChannel: $('guide-channel'),
    guideList: $('guide-list'),
    searchInput: $('search-input'),
    searchClear: $('search-clear'),
    favToggle: $('fav-toggle'),
    categoryChips: $('category-chips'),
    channelList: $('channel-list'),
    toasts: $('toasts'),
    playOverlay: $('play-overlay'),
    playOverlayBtn: $('play-overlay-btn'),
    playerError: $('player-error'),
    playerErrorMsg: $('player-error-msg'),
    playerRetryBtn: $('player-retry-btn'),
    // onboarding
    onboardStepType: $('onboard-step-type'),
    onboardForm: $('onboard-form'),
    onboardFormTitle: $('onboard-form-title'),
    obName: $('ob-name'),
    obHost: $('ob-host'),
    obHostLabel: $('ob-host-label'),
    obHostField: $('ob-host-field'),
    obUsername: $('ob-username'),
    obPassword: $('ob-password'),
    obEpg: $('ob-epg'),
    obEpgField: $('ob-epg-field'),
    obUserField: $('ob-user-field'),
    obPassField: $('ob-pass-field'),
    obRemember: $('ob-remember'),
    obRememberField: $('ob-remember-field'),
    obSubmit: $('ob-submit'),
    obBack: $('ob-back'),
    onboardError: $('onboard-error'),
    // unlock
    unlockForm: $('unlock-form'),
    unlockTitle: $('unlock-title'),
    unlockSub: $('unlock-sub'),
    unlockPassword: $('unlock-password'),
    unlockRemember: $('unlock-remember'),
    unlockSubmit: $('unlock-submit'),
    unlockCancel: $('unlock-cancel'),
    unlockError: $('unlock-error'),
    // profiles pane
    profileList: $('profile-list'),
    profileAddBtn: $('profile-add-btn'),
    // profile modal
    profileForm: $('profile-form'),
    modalBackdrop: $('profile-modal-backdrop'),
    pmTitle: $('pm-title'),
    pmName: $('pm-name'),
    pmType: $('pm-type'),
    pmHost: $('pm-host'),
    pmHostLabel: $('pm-host-label'),
    pmUsername: $('pm-username'),
    pmPassword: $('pm-password'),
    pmEpg: $('pm-epg'),
    pmRemember: $('pm-remember'),
    pmSubmit: $('pm-submit'),
    pmCancel: $('pm-cancel'),
    pmError: $('pm-error'),
    pmHostField: $('pm-host-field'),
    pmUserField: $('pm-user-field'),
    pmPassField: $('pm-pass-field'),
    pmEpgField: $('pm-epg-field'),
    pmRememberField: $('pm-remember-field'),
    pmTypeField: $('pm-type-field'),
  };

  const STAR_PATH =
    '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';

  let pmEditingId = null;
  let onboardType = null;
  let pendingUnlockProfileId = null;

  window.addEventListener('unhandledrejection', (e) => {
    // Redacted diagnostics: log the reason's message only — error objects
    // (e.g. from hls.js) can contain full provider URLs.
    const reason = e && e.reason;
    const msg = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'unknown';
    console.warn('[aerial] unhandled promise rejection:', msg);
  });

  function markUserInteracted() {
    userInteracted = true;
  }
  window.addEventListener('pointerdown', markUserInteracted, { once: true, capture: true });

  // ------------------------------------------------------------- api helper --
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    if (res.status === 401) {
      if (window.__AERIAL_AUTH_MODE !== 'open') showLogin();
      throw new Error('unauthorized');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-json */
    }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- toasts --
  function toast(msg, kind = 'info', ms = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    els.toasts.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px) scale(.96)';
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  // ----------------------------------------------------------- navigation --
  function setPane(name) {
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    $$('.tab').forEach((t) => {
      const on = t.dataset.pane === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setPane(tab.dataset.pane));
  });
  els.switchBtn.addEventListener('click', () => setPane('browse'));
  els.profileChip.addEventListener('click', () => setPane('profiles'));

  // ---------------------------------------------------------------- login ---
  let selectedRole = 'user';
  $$('.role-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedRole = btn.dataset.role;
      $$('.role-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $('login-error').textContent = '';
    });
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('password-input').value;
    const submit = $('login-submit');
    submit.disabled = true;
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: { role: selectedRole, password } });
      enterApp(res.role);
    } catch (err) {
      const msg =
        err.code === 'rate_limited' ? 'Zu viele Versuche. Bitte kurz warten.' :
        err.code === 'invalid_credentials' ? 'Zugriff verweigert — falscher Passkey.' :
        err.message;
      $('login-error').textContent = msg;
    } finally {
      submit.disabled = false;
      $('password-input').value = '';
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    if (window.__AERIAL_AUTH_MODE === 'open') {
      toast('App-Modus ohne Login — Anmeldung ist serverseitig deaktiviert.');
      return;
    }
    teardownApp();
    showLogin();
  });

  function showLogin() {
    teardownApp();
    hideAllViews();
    els.appView.classList.add('hidden');
    els.tabbar.classList.add('hidden');
    els.roleBadge.classList.add('hidden');
    els.logoutBtn.classList.add('hidden');
    els.loginView.classList.remove('hidden');
  }

  function hideAllViews() {
    [els.loginView, els.onboardView, els.unlockView, els.appView].forEach((v) => v && v.classList.add('hidden'));
  }

  // ----------------------------------------------------------------- app ----
  async function enterApp(newRole) {
    role = newRole;
    hideAllViews();
    els.roleBadge.textContent = role.toUpperCase();
    els.roleBadge.classList.remove('hidden');
    els.logoutBtn.classList.remove('hidden');

    profiles = loadProfiles();
    if (!profiles.length) {
      showOnboarding();
      return;
    }

    activeProfileId = getActiveProfileId();
    if (!activeProfileId || !getProfile(activeProfileId)) {
      activeProfileId = profiles[0].id;
      setActiveProfileId(activeProfileId);
    }
    showMainShell();
    connectProfile(activeProfileId);
  }

  function showMainShell() {
    hideAllViews();
    els.appView.classList.remove('hidden');
    els.tabbar.classList.remove('hidden');
    search = '';
    activeCategory = 'all';
    favOnly = false;
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    updateFavToggle();
    setPane('live');
    renderChannels();
  }

  function teardownApp() {
    connectToken += 1; // invalidate in-flight connects
    stopPlayer();
    clearProviderState();
    memorySecret = null;
    adapter = null;
    currentChannel = null;
    lastEpg = null;
    catalogError = null;
    role = null;
    closeProfileModal();
  }

  function clearProviderState() {
    channels = [];
    categories = [];
    recent = [];
    favorites = new Set();
    lastEpg = null;
    xmltvParsed = null;
    xmltvFetchedAt = 0;
    loadingChannels = false;
    catalogError = null;
    lastRenderedActiveId = '__none__';
  }

  // ------------------------------------------------------------ onboarding --
  function showOnboarding(prefillType) {
    hideAllViews();
    els.tabbar.classList.add('hidden');
    els.onboardView.classList.remove('hidden');
    els.onboardError.textContent = '';
    resetOnboardForm(prefillType || null);
  }

  function resetOnboardForm(type) {
    els.onboardStepType.classList.toggle('hidden', Boolean(type));
    els.onboardForm.classList.toggle('hidden', !type);
    if (!type) return;
    const isM3U = type === 'm3u';
    els.onboardFormTitle.textContent = isM3U ? 'Playlist hinzufügen' : 'Konto hinzufügen';
    els.obHostLabel.textContent = isM3U ? 'Playlist-URL (M3U/M3U8)' : 'Server-URL';
    els.obHost.placeholder = isM3U ? 'http://provider.example/playlist.m3u8' : 'http://dein-provider.example:8080';
    els.obUserField.classList.toggle('hidden', isM3U);
    els.obPassField.classList.toggle('hidden', isM3U);
    els.obEpgField.classList.toggle('hidden', !isM3U);
    els.obRememberField.classList.toggle('hidden', isM3U);
    $$('.type-card').forEach((c) => c.classList.remove('selected'));
    onboardType = type;
  }

  $$('.type-card').forEach((card) => {
    card.addEventListener('click', () => {
      $$('.type-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      resetOnboardForm(card.dataset.type);
    });
  });

  els.obBack.addEventListener('click', () => resetOnboardForm(null));

  function mixedContentHint(url) {
    try {
      if (location.protocol === 'https:' && new URL(url).protocol === 'http:') {
        return ' Hinweis: Die App läuft über HTTPS, der Anbieter über HTTP — der Browser blockiert diese Verbindung (Mixed Content).';
      }
    } catch { /* invalid URL — validated elsewhere */ }
    return '';
  }

  function classifyProviderError(err) {
    const e = err || {};
    // Diagnosed failures carry a precise, actionable message already.
    if (e.diagnosisMessage) return e.diagnosisMessage;
    if (e.code === 'timeout') {
      return `Zeitüberschreitung${e.stage ? ` bei „${e.stage}"` : ''} — die Verbindung ist zu langsam. Stabiles WLAN verwenden und erneut versuchen.`;
    }
    if (e.code === 'network_or_cors' || err instanceof TypeError) {
      return `Anbieter nicht erreichbar (Netzwerk oder CORS).${mixedContentHint(e.providerUrl)}`;
    }
    if (e.code === 'invalid_credentials') return 'Der Anbieter hat die Zugangsdaten abgelehnt.';
    if (e.code === 'invalid_playlist') return 'Die URL liefert keine gültige M3U/M3U8-Playlist.';
    if (e.code === 'invalid_response') return 'Der Anbieter hat eine ungültige Antwort gesendet.';
    if (e.code === 'http_error') return `Der Anbieter antwortet mit HTTP ${e.status}.`;
    return e.message || 'Unbekannter Verbindungsfehler.';
  }

  /**
   * Render a provider error into one of the error <p> elements: message
   * text plus an optional clickable self-test URL (opens the provider's
   * real API/playlist address in a new tab so the user can distinguish a
   * blocked provider from an app problem).
   */
  function renderProviderError(el, err) {
    if (!el) return;
    el.textContent = classifyProviderError(err);
    const url = err && err.testUrl;
    if (url && /^https?:\/\//i.test(url)) {
      const br = document.createElement('br');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '→ Selbst-Test: Anbieter-Adresse im Browser öffnen';
      el.appendChild(br);
      el.appendChild(a);
    }
  }

  function isNetworkFailure(err) {
    return Boolean(err && (err.code === 'network_or_cors' || err instanceof TypeError));
  }

  function isTimeoutFailure(err) {
    return Boolean(err && err.code === 'timeout');
  }

  /** Adapter for a (possibly upgraded) host — used for staged diagnosis. */
  function buildStageUrls(type, host, username, password, epgUrl) {
    const { adapter } = createAdapter({ type, host, username, password, epgUrl });
    return typeof adapter.stageUrls === 'function' ? adapter.stageUrls() : null;
  }

  /**
   * Attempt a full provider connection (authenticate + catalog) for one
   * host. Returns the authenticated adapter, throws the provider error.
   */
  async function attemptConnect({ type, host, username, password, epgUrl }) {
    const { adapter } = createAdapter({ type, host, username, password, epgUrl });
    if (type === 'xtream') await adapter.authenticate();
    const { channels } = await adapter.getChannels();
    if (!channels.length) {
      const err = new Error('Der Anbieter hat keine Sender geliefert.');
      err.code = 'empty_catalog';
      throw err;
    }
    return adapter;
  }

  /**
   * Connect with automatic HTTPS upgrade + staged failure diagnosis.
   *
   * Transport failures in browsers are opaque (DNS block, adblocker,
   * firewall, slow links and genuine CORS refusals all look alike), and a
   * timed-out 20 MB catalog fetch used to be misreported as "CORS". Now:
   *  - timeouts get their own error class (code 'timeout') with a large
   *    catalog budget (90s) in the adapters
   *  - http:// hosts failing at transport level try the https:// twin
   *  - if everything fails, the provider's REAL request sequence
   *    (Anmeldung -> Kategorien -> Senderliste) is re-run stage by stage
   *    to pinpoint the failing step and its actual cause
   *
   * Returns { adapter, host, upgraded }. Throws an error enriched with
   * `diagnosisMessage` and `testUrl` when everything failed.
   */
  async function connectWithDiagnosis({ type, host, username, password, epgUrl }) {
    let firstErr = null;
    try {
      const adapter = await attemptConnect({ type, host, username, password, epgUrl });
      return { adapter, host, upgraded: false };
    } catch (err) {
      if (!isNetworkFailure(err) && !isTimeoutFailure(err)) throw err; // real provider answer
      firstErr = err;
    }

    // Transport-level failure on http://: try the https twin before giving
    // up (NOT for timeouts — the twin sits on the same edge and would only
    // double the wait).
    if (isNetworkFailure(firstErr)) {
      const twin = httpsTwin(host);
      if (twin) {
        try {
          const adapter = await attemptConnect({ type, host: twin, username, password, epgUrl });
          return { adapter, host: twin, upgraded: true };
        } catch (err) {
          if (!isNetworkFailure(err) && !isTimeoutFailure(err)) throw err; // https answered — trust it
          firstErr = firstErr || err;
        }
      }
    }

    // Everything failed: re-run the provider's real request sequence to
    // identify the failing stage and the actual cause on THIS device.
    const wrap = firstErr || new Error('Verbindung fehlgeschlagen.');
    wrap.code = wrap.code || 'network_or_cors';
    wrap.providerUrl = host;
    const stages = buildStageUrls(type, host, username, password, epgUrl);
    if (stages) {
      const diag = await diagnoseStages(stages);
      if (diag.kind === 'ok') {
        wrap.diagnosisMessage = okDiagnosisMessage(wrap, diag);
      } else {
        wrap.diagnosisMessage = diag.message;
        if (diag.testUrl) wrap.testUrl = diag.testUrl;
      }
    } else {
      wrap.diagnosisMessage =
        isTimeoutFailure(wrap)
          ? 'Die Verbindung war zu langsam und wurde abgebrochen. Stabiles WLAN verwenden und erneut versuchen.'
          : 'Der Anbieter ist nicht erreichbar. Netzwerk/Werbeblocker prüfen und erneut versuchen.';
    }
    throw wrap;
  }

  /**
   * Message when the staged diagnosis passes but the original connect
   * failed: the provider answers fine — the full catalog download was the
   * problem. Header-only stages pass on links that cannot sustain a 20 MB
   * body transfer, so "transient" would be a lie for timeouts.
   */
  function okDiagnosisMessage(err, diag) {
    if (isTimeoutFailure(err)) {
      let detail = '';
      if (diag && diag.throughputKBs && diag.throughputKBs >= 1) {
        const minutes = Math.max(1, Math.round(20480 / diag.throughputKBs / 60));
        detail =
          ` Gemessene Geschwindigkeit zum Anbieter: ~${Math.round(diag.throughputKBs)} KB/s — ` +
          `die Senderliste (20+ MB) braucht damit ca. ${minutes} Min.`;
        if (minutes > 5) {
          detail += ' Diese Verbindung reicht dafür voraussichtlich nicht aus — schnelleres Netz/WLAN oder VPN nutzen.';
        }
      }
      return (
        'Der Anbieter antwortet, aber der Download der großen Senderliste wurde abgebrochen — die Verbindung ist zu langsam oder instabil.' +
        detail +
        ' Bitte erneut versuchen und die App dabei geöffnet lassen.'
      );
    }
    return (
      'Die Verbindung funktioniert jetzt auf Anhieb — der erste Versuch war vermutlich eine kurze Schwankung. Bitte erneut versuchen.'
    );
  }

  els.onboardForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onboardType) return;
    const name = els.obName.value.trim() || 'Mein IPTV';
    const host = els.obHost.value.trim();
    const username = els.obUsername.value.trim();
    const password = els.obPassword.value;
    const epgUrl = els.obEpg.value.trim();
    const remember = !isM3UOnboard() && els.obRemember.checked;
    if (!/^https?:\/\//i.test(host)) {
      els.onboardError.textContent = 'Die URL muss mit http:// oder https:// beginnen.';
      return;
    }
    if (onboardType === 'xtream' && (!username || !password)) {
      els.onboardError.textContent = 'Benutzername und Passwort sind für Xtream erforderlich.';
      return;
    }

    els.obSubmit.disabled = true;
    els.obSubmit.querySelector('span').textContent = 'Verbinde … (große Senderlisten können etwas dauern)';
    els.onboardError.textContent = '';
    try {
      const { adapter, host: connectedHost, upgraded } = await connectWithDiagnosis({
        type: onboardType, host, username, password, epgUrl,
      });
      const { channels: loaded } = await adapter.getChannels();

      const profile = upsertProfile({
        id: newProfileId(),
        type: onboardType,
        name,
        host: connectedHost, // https twin when the http host was unreachable
        username: onboardType === 'xtream' ? username : '',
        epgUrl: onboardType === 'm3u' ? epgUrl || '' : '',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
      if (onboardType === 'xtream' && remember) setRememberedSecret(profile.id, password);

      showMainShell();
      await connectProfile(profile.id, {
        secret: onboardType === 'xtream' ? password : null,
        adapter, // reuse the probed catalog — no double fetch
      });
      toast(upgraded
        ? `Verbunden über HTTPS · ${loaded.length} Sender`
        : `${profile.name} verbunden · ${loaded.length} Sender`);
    } catch (err) {
      if (err && !err.providerUrl) err.providerUrl = host;
      renderProviderError(els.onboardError, err);
    } finally {
      els.obSubmit.disabled = false;
      els.obSubmit.querySelector('span').textContent = 'Verbinden & testen';
      els.obPassword.value = '';
    }
  });

  function isM3UOnboard() {
    return onboardType === 'm3u';
  }

  // ------------------------------------------------------------ unlock ------
  function showUnlock(profile, errorMsg) {
    hideAllViews();
    els.tabbar.classList.add('hidden');
    els.unlockView.classList.remove('hidden');
    els.unlockTitle.textContent = `${profile.name} entsperren`;
    els.unlockSub.textContent = `Gib das Passwort deines IPTV-Zugangs (${profile.host}) ein.`;
    els.unlockError.textContent = errorMsg || '';
    els.unlockPassword.value = '';
    pendingUnlockProfileId = profile.id;
  }

  els.unlockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const profile = getProfile(pendingUnlockProfileId);
    if (!profile) return showMainShell();
    const password = els.unlockPassword.value;
    els.unlockSubmit.disabled = true;
    try {
      if (els.unlockRemember.checked) setRememberedSecret(profile.id, password);
      showMainShell();
      await connectProfile(profile.id, { secret: password });
    } catch (err) {
      if (err && !err.providerUrl) err.providerUrl = profile.host;
      showUnlock(profile, classifyProviderError(err));
    } finally {
      els.unlockSubmit.disabled = false;
      els.unlockPassword.value = '';
    }
  });

  els.unlockCancel.addEventListener('click', () => {
    pendingUnlockProfileId = null;
    profiles = loadProfiles();
    if (profiles.length) {
      showMainShell();
      renderProfileList();
    } else {
      showOnboarding();
    }
  });

  // ---------------------------------------------------------- connections ---
  function createAdapter({ type, host, username, password, epgUrl }) {
    if (type === 'xtream') {
      return { type, adapter: new XtreamAdapter({ host, username, password }) };
    }
    if (type === 'm3u') {
      return { type, adapter: new M3UAdapter({ url: host, epgUrl }) };
    }
    throw new Error('Unbekannter Verbindungstyp.');
  }

  /**
   * Activate a profile: stop the running stream, clear all state of the
   * previous provider, then load the new catalog. `connectToken` guards
   * every async step so late responses from a previous provider can never
   * overwrite the current state.
   */
  async function connectProfile(id, opts = {}) {
    const profile = getProfile(id);
    if (!profile) return;

    const token = ++connectToken;
    stopPlayer();
    clearProviderState();
    if (adapter) adapter.disconnect();
    adapter = null;
    memorySecret = opts.secret !== undefined ? opts.secret : null;
    activeProfileId = id;
    setActiveProfileId(id);
    upsertProfile({ ...profile, lastUsedAt: Date.now() });
    profiles = loadProfiles();

    // Xtream needs credentials; M3U usually does not.
    if (profile.type === 'xtream' && !memorySecret) {
      const remembered = getRememberedSecret(id);
      if (!remembered) {
        renderProfileList();
        showUnlock(profile);
        return;
      }
      memorySecret = remembered;
    }

    const built = createAdapter({
      type: profile.type,
      host: profile.host,
      username: profile.username,
      password: memorySecret,
      epgUrl: profile.epgUrl,
    });
    // Onboarding / profile creation already probed a fully authenticated
    // adapter with a cached catalog — reuse it instead of re-fetching
    // (huge catalogs are 15+ MB; a second fetch doubles the wait).
    adapter = opts.adapter || built.adapter;

    favorites = getFavorites(id);
    recent = getRecent(id);
    loadingChannels = true;
    catalogError = null;
    els.profileChip.textContent = profile.name;
    els.profileChip.classList.add('pointer');
    els.connDot.className = 'conn-dot';
    renderChannels();
    renderProfileList();

    try {
      const { channels: list, categories: cats } = await adapter.getChannels();
      if (token !== connectToken) return; // stale — a newer connect won
      channels = list;
      categories = cats;
      listVersion += 1; // catalog changed — force a fresh windowed render
      catalogError = null;
      els.connDot.className = 'conn-dot on';
    } catch (err) {
      if (token !== connectToken) return;

      // Transport-level failure on a stored http:// host: retry the https
      // twin — if it works, persist the upgrade so it sticks.
      if (isNetworkFailure(err)) {
        const twin = httpsTwin(profile.host);
        if (twin) {
          try {
            const upgradedAdapter = createAdapter({
              type: profile.type,
              host: twin,
              username: profile.username,
              password: memorySecret,
              epgUrl: profile.epgUrl,
            }).adapter;
            const { channels: list, categories: cats } = await upgradedAdapter.getChannels();
            if (token !== connectToken) return;
            adapter = upgradedAdapter;
            channels = list;
            categories = cats;
            listVersion += 1;
            catalogError = null;
            els.connDot.className = 'conn-dot on';
            upsertProfile({ ...getProfile(id), host: twin, lastUsedAt: Date.now() });
            profiles = loadProfiles();
            toast('HTTP nicht erreichbar — Profil wurde auf HTTPS umgestellt.');
            renderProfileList();
            return;
          } catch (upgradeErr) {
            if (!isNetworkFailure(upgradeErr)) {
              // https answered with a real provider error — report that.
              if (token !== connectToken) return;
              if (!upgradeErr.providerUrl) upgradeErr.providerUrl = twin;
              err = upgradeErr;
            }
          }
        }
      }

      if (err && !err.providerUrl) err.providerUrl = profile.host;
      if ((isNetworkFailure(err) || isTimeoutFailure(err)) && adapter && typeof adapter.stageUrls === 'function') {
        // Re-run the provider's real request sequence to pinpoint the
        // failing stage (Anmeldung/Kategorien/Senderliste) and its cause.
        const diag = await diagnoseStages(adapter.stageUrls());
        if (diag.kind !== 'ok') {
          err.diagnosisMessage = diag.message;
          if (diag.testUrl) err.testUrl = diag.testUrl;
        } else {
          err.diagnosisMessage = okDiagnosisMessage(err, diag);
        }
      }
      catalogError = classifyProviderError(err);
      els.connDot.className = 'conn-dot off';
      if (err && err.code === 'invalid_credentials') {
        setRememberedSecret(id, null); // remembered secret went stale
        memorySecret = null;
        renderProfileList();
        showUnlock(profile, catalogError);
        return;
      }
    } finally {
      if (token === connectToken) {
        loadingChannels = false;
        renderChannels();
        renderCategories();
        renderProfileList();
      }
    }

    // Restore last watched channel (paused, no autoplay-spam).
    if (token === connectToken && recent.length && currentChannel === null) {
      const last = channels.find((c) => c.id === recent[0].id);
      if (last) selectChannel(last, { silent: true });
    }
  }

  // ------------------------------------------------------- profile list UI --
  function renderProfileList() {
    if (!els.profileList) return;
    els.profileList.innerHTML = '';
    const list = loadProfiles();
    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = 'Noch keine Profile angelegt.';
      els.profileList.appendChild(div);
      return;
    }
    for (const p of list) {
      els.profileList.appendChild(buildProfileCard(p));
    }
  }

  function buildProfileCard(p) {
    const card = document.createElement('div');
    card.className = 'profile-card' + (p.id === activeProfileId ? ' active' : '');

    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar';
    avatar.textContent = (p.name || '?').charAt(0).toUpperCase();

    const body = document.createElement('div');
    body.className = 'profile-body';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = p.name || p.host;
    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    meta.textContent = `${p.type === 'xtream' ? 'Xtream' : 'M3U'} · ${p.host}`;
    body.appendChild(name);
    body.appendChild(meta);
    if (p.id === activeProfileId) {
      const status = document.createElement('div');
      status.className = 'profile-status' + (catalogError ? ' locked' : '');
      status.textContent = catalogError ? 'Verbindungsproblem' : 'Aktiv';
      body.appendChild(status);
    }

    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    if (p.id !== activeProfileId) {
      const activate = document.createElement('button');
      activate.className = 'btn btn-primary';
      activate.textContent = 'Aktivieren';
      activate.addEventListener('click', () => {
        connectProfile(p.id).catch(() => {});
        toast(`${p.name} wird verbunden…`);
      });
      actions.appendChild(activate);
    }

    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.setAttribute('aria-label', 'Profil bearbeiten');
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    edit.addEventListener('click', () => openProfileModal(p));
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.setAttribute('aria-label', 'Profil löschen');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9-2.5h4M7 7l1 13h8l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', () => {
      // Native confirm dialogs are silently ignored by iOS standalone PWAs,
      // so we use an explicit in-app two-step confirmation instead.
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.classList.add('armed');
        del.setAttribute('aria-label', 'Löschen bestätigen');
        del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        toast('Erneut tippen, um das Profil endgültig zu löschen.', 'warn', 3500);
        setTimeout(() => {
          if (!del.isConnected) return;
          del.dataset.armed = '';
          del.classList.remove('armed');
          del.setAttribute('aria-label', 'Profil löschen');
          del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9-2.5h4M7 7l1 13h8l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }, 3500);
        return;
      }
      deleteProfile(p.id);
      profiles = loadProfiles();
      renderProfileList();
      if (p.id === activeProfileId) {
        if (profiles.length) connectProfile(profiles[0].id).catch(() => {});
        else {
          // Soft teardown: keep the Aerial session, drop all provider state.
          connectToken += 1;
          stopPlayer();
          clearProviderState();
          if (adapter) adapter.disconnect();
          adapter = null;
          memorySecret = null;
          activeProfileId = null;
          showOnboarding();
        }
      }
    });
    actions.appendChild(del);

    card.appendChild(avatar);
    card.appendChild(body);
    card.appendChild(actions);
    return card;
  }

  // ------------------------------------------------------ profile modal -----
  function openProfileModal(profile) {
    pmEditingId = profile ? profile.id : null;
    els.pmTitle.textContent = profile ? 'Profil bearbeiten' : 'Profil hinzufügen';
    els.pmError.textContent = '';
    els.pmName.value = profile ? profile.name : '';
    els.pmType.value = profile ? profile.type : 'xtream';
    els.pmTypeField.classList.toggle('hidden', Boolean(profile)); // type is immutable once created
    els.pmHost.value = profile ? profile.host : '';
    els.pmUsername.value = profile ? profile.username : '';
    els.pmPassword.value = '';
    els.pmPassword.placeholder = profile ? 'leer lassen = unverändert' : 'Passwort';
    els.pmEpg.value = profile ? profile.epgUrl || '' : '';
    els.pmRemember.checked = profile ? Boolean(getRememberedSecret(profile.id)) : false;
    syncProfileFormFields();
    els.modalBackdrop.classList.remove('hidden');
  }

  function closeProfileModal() {
    if (els.modalBackdrop) els.modalBackdrop.classList.add('hidden');
    pmEditingId = null;
  }

  function syncProfileFormFields() {
    const isM3U = els.pmType.value === 'm3u';
    els.pmHostLabel.textContent = isM3U ? 'Playlist-URL (M3U/M3U8)' : 'Server-URL';
    els.pmHost.placeholder = isM3U ? 'http://provider.example/playlist.m3u8' : 'http://dein-provider.example:8080';
    els.pmUserField.classList.toggle('hidden', isM3U);
    els.pmPassField.classList.toggle('hidden', isM3U);
    els.pmEpgField.classList.toggle('hidden', !isM3U);
    els.pmRememberField.classList.toggle('hidden', isM3U);
  }

  els.pmType.addEventListener('change', syncProfileFormFields);
  els.pmCancel.addEventListener('click', closeProfileModal);
  els.modalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.modalBackdrop) closeProfileModal();
  });

  els.profileAddBtn.addEventListener('click', () => openProfileModal(null));

  els.profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.pmName.value.trim() || 'Mein IPTV';
    const type = els.pmType.value;
    const host = els.pmHost.value.trim();
    const username = els.pmUsername.value.trim();
    const password = els.pmPassword.value;
    const epgUrl = els.pmEpg.value.trim();
    const remember = type === 'xtream' && els.pmRemember.checked;

    if (!/^https?:\/\//i.test(host)) {
      els.pmError.textContent = 'Die URL muss mit http:// oder https:// beginnen.';
      return;
    }
    if (type === 'xtream' && !pmEditingId && !username) {
      els.pmError.textContent = 'Benutzername ist für Xtream erforderlich.';
      return;
    }

    els.pmSubmit.disabled = true;
    els.pmError.textContent = '';
    try {
      let saved;
      let probeRef = null;
      if (pmEditingId) {
        const existing = getProfile(pmEditingId);
        if (!existing) throw new Error('Profil nicht gefunden.');
        saved = upsertProfile({
          ...existing,
          name,
          host,
          username: type === 'xtream' ? (username || existing.username) : '',
          epgUrl: type === 'm3u' ? epgUrl : '',
        });
        if (password) setRememberedSecret(saved.id, remember ? password : null);
        else if (!remember) setRememberedSecret(saved.id, null);
      } else {
        // New profile: validate the connection before saving (with
        // automatic https upgrade + diagnosis on transport failures).
        const { adapter, host: connectedHost, upgraded } = await connectWithDiagnosis({
          type, host, username, password, epgUrl,
        });
        probeRef = adapter;
        saved = upsertProfile({
          id: newProfileId(),
          type,
          name,
          host: connectedHost, // https twin when http was unreachable
          username: type === 'xtream' ? username : '',
          epgUrl: type === 'm3u' ? epgUrl : '',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        if (remember) setRememberedSecret(saved.id, password);
        if (upgraded) toast('HTTP nicht erreichbar — HTTPS-Variante wird verwendet.');
      }
      closeProfileModal();
      profiles = loadProfiles();
      renderProfileList();
      if (!pmEditingId || saved.id === activeProfileId) {
        await connectProfile(saved.id, {
          secret: type === 'xtream' ? password : undefined,
          // For brand-new profiles reuse the probed catalog — no double fetch.
          adapter: pmEditingId ? undefined : probeRef,
        });
        toast(`${saved.name} verbunden`);
      } else {
        toast(`${saved.name} gespeichert`);
      }
    } catch (err) {
      renderProviderError(els.pmError, err);
    } finally {
      els.pmSubmit.disabled = false;
      els.pmPassword.value = '';
    }
  });

  // ------------------------------------------------------------- favorites --
  function toggleFavorite(id) {
    if (!activeProfileId) return;
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    saveFavorites(activeProfileId, favorites);
    if (favOnly) {
      renderChannels({ force: true }); // list membership changed — re-filter
    } else {
      updateFavStar(id); // in-place star update: no rebuild, no scroll jump
    }
    updateFavToggle();
  }

  function updateFavStar(id) {
    const card = els.channelList.querySelector(`.channel-card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const fav = card.querySelector('.channel-fav');
    if (!fav) return;
    const on = favorites.has(id);
    fav.classList.toggle('on', on);
    fav.setAttribute('aria-label', on ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen');
  }

  function updateFavToggle() {
    if (els.favToggle) els.favToggle.classList.toggle('active', favOnly);
  }

  // -------------------------------------------------------------- channels --
  function renderCategories() {
    // Rebuilding 900+ chips on every channel switch is wasteful — render
    // only when the category set, the recent-chip visibility or the active
    // chip actually changed.
    const sig = `${categories.length}|${recent.length > 0}|${activeCategory}`;
    if (sig === categoriesSignature) return;
    categoriesSignature = sig;
    const chips = [{ id: 'all', name: 'Alle' }];
    if (recent.length) chips.push({ id: '__recent', name: 'Zuletzt' });
    for (const c of categories) chips.push(c);
    els.categoryChips.innerHTML = '';
    for (const c of chips) {
      const b = document.createElement('button');
      b.className = 'chip' + (c.id === activeCategory ? ' active' : '');
      b.textContent = c.name;
      b.addEventListener('click', () => {
        activeCategory = c.id;
        renderCategories();
        renderChannels();
      });
      els.categoryChips.appendChild(b);
    }
  }

  /** Filter pipeline for the channel list. Pure — no DOM. */
  function computeFiltered() {
    const recentIds = activeCategory === '__recent' ? new Set(recent.map((r) => r.id)) : null;
    const q = search.trim().toLowerCase();
    const filtered = channels.filter((c) => {
      if (!c) return false;
      if (activeCategory === '__recent') {
        if (!recentIds.has(c.id)) return false;
      } else if (activeCategory !== 'all' && c.categoryId !== activeCategory) return false;
      if (favOnly && !favorites.has(c.id)) return false;
      if (q && !(c.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (activeCategory === '__recent') {
      filtered.sort((a, b) => {
        const ia = recent.findIndex((r) => r.id === a.id);
        const ib = recent.findIndex((r) => r.id === b.id);
        return ia - ib;
      });
    }
    const signature = [listVersion, activeCategory, favOnly, q, recent.length, recent[0] ? recent[0].id : ''].join('|');
    return { filtered, signature };
  }

  function renderChannels(opts = {}) {
    if (!els.channelList) return;
    if (loadingChannels && !channels.length) {
      renderSkeletons();
      return;
    }

    if (catalogError && !channels.length) {
      destroyListObserver();
      els.channelList.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'error-card';
      const title = document.createElement('div');
      title.className = 'error-title';
      title.textContent = 'Provider nicht erreichbar';
      const msg = document.createElement('div');
      msg.className = 'error-msg';
      msg.textContent = catalogError;
      const retry = document.createElement('button');
      retry.className = 'btn btn-primary';
      retry.textContent = 'Erneut versuchen';
      retry.addEventListener('click', () => {
        if (activeProfileId) connectProfile(activeProfileId).catch(() => {});
      });
      card.appendChild(title);
      card.appendChild(msg);
      card.appendChild(retry);
      els.channelList.appendChild(card);
      return;
    }

    const { filtered, signature } = computeFiltered();

    // Same filter state as before: just refresh the active highlight —
    // no DOM rebuild (keeps scroll position and avoids re-render costs).
    if (!opts.force && signature === renderedSignature) {
      updateActiveChannelHighlight();
      return;
    }
    renderedSignature = signature;

    // Windowed rendering: huge catalogs (50k+ channels) must never be
    // rendered as one DOM tree — render the first page and append more
    // via IntersectionObserver as the user scrolls.
    destroyListObserver();
    els.channelList.innerHTML = '';
    renderLimit = Math.min(PAGE_INITIAL, filtered.length);
    if (!filtered.length) {
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = channels.length
        ? 'Keine Treffer für deine Suche.'
        : 'Keine Sender verfügbar.';
      els.channelList.appendChild(div);
      return;
    }

    appendChannelRange(filtered, 0, renderLimit, true);
    if (renderLimit < filtered.length) attachListSentinel(filtered);
    lastRenderedActiveId = '__none__';
    updateActiveChannelHighlight();
  }

  function appendChannelRange(filtered, from, to, animate) {
    const activeId = currentChannel ? currentChannel.id : null;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to && i < filtered.length; i++) {
      frag.appendChild(buildChannelCard(filtered[i], activeId, animate ? i : -1));
    }
    els.channelList.appendChild(frag);
  }

  function attachListSentinel(filtered) {
    const sentinel = document.createElement('div');
    sentinel.className = 'list-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    els.channelList.appendChild(sentinel);
    listObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const from = renderLimit;
        const to = Math.min(filtered.length, from + PAGE_STEP);
        if (to <= from) {
          destroyListObserver();
          return;
        }
        renderLimit = to;
        appendChannelRange(filtered, from, to, false);
        if (renderLimit >= filtered.length) destroyListObserver();
      },
      { root: null, rootMargin: '700px' },
    );
    listObserver.observe(sentinel);
  }

  function destroyListObserver() {
    if (listObserver) {
      listObserver.disconnect();
      listObserver = null;
    }
  }

  /** Toggle the active card in place — no list rebuild, no scroll jump. */
  function updateActiveChannelHighlight() {
    const activeId = currentChannel ? currentChannel.id : null;
    if (activeId === lastRenderedActiveId) return;
    for (const card of els.channelList.querySelectorAll('.channel-card')) {
      card.classList.toggle('active', card.dataset.id === activeId);
    }
    lastRenderedActiveId = activeId;
  }

  function buildChannelCard(c, activeId, i) {
    const card = document.createElement('div');
    card.className = 'channel-card' + (c.id === activeId ? ' active' : '');
    card.dataset.id = c.id;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    // Stagger only the first rendered page; appended pages appear instantly.
    card.style.animationDelay = i >= 0 && i < 15 ? `${i * 16}ms` : '0ms';

    const logo = document.createElement('div');
    logo.className = 'channel-logo';
    if (c.logo) {
      const img = document.createElement('img');
      img.src = c.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        logo.innerHTML = '';
        logo.textContent = (c.name || '?').charAt(0).toUpperCase();
      });
      logo.appendChild(img);
    } else {
      logo.textContent = (c.name || '?').charAt(0).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'channel-body';
    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = c.name;
    const cat = document.createElement('div');
    cat.className = 'channel-cat';
    cat.textContent = c.categoryName || '';
    body.appendChild(name);
    body.appendChild(cat);

    const fav = document.createElement('button');
    fav.className = 'channel-fav' + (favorites.has(c.id) ? ' on' : '');
    fav.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAR_PATH}</svg>`;
    fav.setAttribute('aria-label', favorites.has(c.id) ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen');
    fav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(c.id);
    });

    card.appendChild(logo);
    card.appendChild(body);
    card.appendChild(fav);

    const activate = () => selectChannel(c);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    return card;
  }

  function renderSkeletons() {
    els.channelList.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.innerHTML =
        '<div class="sk-logo"></div><div class="sk-line"></div><div class="sk-line short"></div>';
      els.channelList.appendChild(sk);
    }
  }

  // -------------------------------------------------------------- playback --
  function selectChannel(channel, opts = {}) {
    if (!channel) return;
    if (currentChannel && currentChannel.id === channel.id && !opts.force) {
      setPane('live');
      return;
    }
    currentChannel = channel;
    if (activeProfileId) pushRecent(activeProfileId, channel);
    recent = getRecent(activeProfileId);
    renderCategories();
    renderChannels();

    els.channelTitle.textContent = channel.name || '—';
    els.channelMeta.textContent = [channel.categoryName, channel.num ? `Sender ${channel.num}` : null]
      .filter(Boolean).join('  ·  ');
    els.offline.classList.add('hidden');
    els.liveBadge.classList.remove('hidden');

    const url = getStreamUrlFor(channel);
    if (!url) {
      showPlayerError('no-url');
      return;
    }
    attachPlayer(channel, url);
    maybeRefreshEpg();
    updateMediaSession();
    if (!opts.silent) setPane('live');
  }

  function getStreamUrlFor(channel) {
    if (!adapter || !channel) return null;
    if (typeof adapter.getStreamUrl === 'function') {
      return adapter.getStreamUrl(channel.id);
    }
    return null;
  }

  // ---------------------------------------------------------------- player --
  /**
   * Pure A/V teardown: exactly one video element and at most one hls.js
   * instance exist at any time. Does NOT touch channel/UI state, so it is
   * safe to call from attachPlayer (channel switch, recovery, reconnect).
   */
  function detachPipeline() {
    clearTimeout(recoveryTimer);
    clearTimeout(stallTimer);
    recoveryPending = false;
    autoplayBlocked = false;
    playerErrorKind = null;
    if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
    if (els.video) {
      els.video.pause();
      els.video.removeAttribute('src');
      try { els.video.load(); } catch { /* ignore */ }
    }
    hidePlayOverlay();
    hidePlayerError();
  }

  /** Full stop: pipeline + UI + session state (provider switch, logout). */
  function stopPlayer() {
    detachPipeline();
    currentChannel = null;
    lastEpg = null;
    els.liveBadge.classList.add('hidden');
    els.offline.classList.remove('hidden');
    els.channelTitle.textContent = '— Aus —';
    els.channelMeta.textContent = '';
    els.epgPanel.classList.add('hidden');
    renderGuide();
    clearMediaSession();
  }

  function attachPlayer(channel, url, opts = {}) {
    if (!els.video) return;
    detachPipeline(); // single-stream invariant: kill the previous pipeline first
    // Fresh user-initiated attach gets a fresh recovery budget; recovery
    // re-attaches must NOT reset it, otherwise failed recoveries loop forever.
    if (!opts.isRecovery) recoveryAttempts = 0;
    currentChannel = channel;
    const video = els.video;

    const isTs = /\.ts($|\?)/i.test(url);
    const nativeHls = Boolean(
      video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('audio/mpegurl'),
    );
    const nativeTs = Boolean(video.canPlayType('video/mp2t'));

    if ((nativeHls && !isTs) || nativeTs) {
      // Native path (iOS/macOS Safari, some Android browsers): direct URL,
      // no CORS requirement for media playback.
      video.src = url;
      attemptPlay();
    } else if (window.Hls && window.Hls.isSupported() && !isTs) {
      hls = new window.Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 3,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => attemptPlay());
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data || !data.fatal) return;
        scheduleRecovery('hls-' + (data.details || data.type || 'error'));
      });
    } else if (isTs) {
      // Raw MPEG-TS stream without native support (Chrome/Firefox/Edge via
      // hls.js cannot play a continuous TS URL): honest compatibility error.
      showPlayerError('raw-ts');
    } else {
      toast('Dieser Browser unterstützt kein HLS-Streaming.', 'err');
    }
  }

  function attemptPlay() {
    if (!els.video || !currentChannel) return;
    let p;
    try {
      p = els.video.play();
    } catch (err) {
      handlePlayFailure(err);
      return;
    }
    if (p && typeof p.then === 'function') {
      p.then(
        () => {
          autoplayBlocked = false;
          hidePlayOverlay();
        },
        handlePlayFailure,
      );
    }
  }

  function handlePlayFailure(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') {
      autoplayBlocked = true;
      showPlayOverlay();
      return;
    }
    if (name === 'AbortError') {
      return; // superseded by a newer load/play cycle — benign
    }
    scheduleRecovery('play-' + (name || 'unknown'));
  }

  function scheduleRecovery(reason) {
    if (!currentChannel) return;
    hidePlayOverlay();
    if (recoveryPending) return; // coalesce: exactly one recovery loop
    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      showPlayerError(reason);
      return;
    }
    recoveryPending = true;
    const delay = Math.min(8000, 500 * 2 ** recoveryAttempts);
    recoveryAttempts += 1;
    recoveryTimer = setTimeout(() => {
      recoveryPending = false;
      recover();
    }, delay);
  }

  async function recover() {
    if (!currentChannel) return;
    const channelId = currentChannel.id;
    const url = getStreamUrlFor(currentChannel);
    if (!url) {
      showPlayerError('no-url');
      return;
    }
    // Same channel still selected: rebuild the pipeline (fresh tokens/URL).
    // Provider switches and channel switches already own the pipeline via
    // stopPlayer() — the single-stream invariant is preserved.
    const channel = channels.find((c) => c.id === channelId) || currentChannel;
    attachPlayer(channel, url, { isRecovery: true });
  }

  function setupVideoListeners() {
    const video = els.video;
    if (!video) return;

    video.addEventListener('error', () => {
      if (!currentChannel) return;
      const code = video.error ? video.error.code : 0;
      scheduleRecovery('video-error-' + code);
    });

    video.addEventListener('stalled', () => {
      if (!currentChannel || autoplayBlocked) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (currentChannel && !video.ended && video.readyState < 3) scheduleRecovery('stalled');
      }, 10_000);
    });

    video.addEventListener('waiting', () => {
      if (!currentChannel) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (currentChannel && !video.ended && video.readyState < 3) scheduleRecovery('stalled');
      }, 12_000);
    });

    video.addEventListener('timeupdate', () => clearTimeout(stallTimer));
    video.addEventListener('playing', () => {
      recoveryAttempts = 0; // real progress resets the budget
      hidePlayerError();
      hidePlayOverlay();
    });
    video.addEventListener('canplay', () => {
      if (autoplayBlocked && userInteracted && currentChannel) attemptPlay();
    });
    video.addEventListener('pause', () => {
      if (document.visibilityState === 'visible') userPaused = true;
    });
    video.addEventListener('play', () => {
      userPaused = false;
    });
  }
  setupVideoListeners();

  // ----------------------------------------------------------- overlays ----
  function showPlayOverlay() {
    if (els.playOverlay) els.playOverlay.classList.remove('hidden');
  }
  function hidePlayOverlay() {
    if (els.playOverlay) els.playOverlay.classList.add('hidden');
  }
  function showPlayerError(kind) {
    if (!els.playerError) return;
    playerErrorKind = kind;
    els.playerErrorMsg.textContent = friendlyPlayerError(kind);
    els.playerError.classList.remove('hidden');
  }
  function hidePlayerError() {
    if (els.playerError) els.playerError.classList.add('hidden');
  }

  function friendlyPlayerError(kind) {
    const k = String(kind || '');
    if (k === 'raw-ts') {
      return 'Dieser Sender liefert einen Roh-TS-Stream, den dieser Browser nicht wiedergeben kann. Safari (iPhone/iPad/Mac) spielt ihn nativ ab.';
    }
    if (k === 'no-url') return 'Für diesen Sender ist keine Stream-URL verfügbar.';
    if (k.startsWith('hls-manifestLoadError') || k.startsWith('hls-manifestParsingError')) {
      return 'Stream nicht ladbar — der Anbieter blockiert möglicherweise die Browser-Wiedergabe (CORS) oder ist offline.';
    }
    if (k.startsWith('stalled')) return 'Stream stockt — Verbindung prüfen.';
    return 'Stream-Fehler — Verbindung nicht stabil.';
  }

  // -------------------------------------------------------- lifecycle sync --
  function onLifecycleSync(force) {
    if (!role) return;
    const t = Date.now();
    if (!force && t - lastLifecycleSync < 2000) return; // no request spam
    lastLifecycleSync = t;
    api('/api/auth/me').catch(() => {}); // 401 → login flow
    maybeRefreshEpg();
    if (
      els.video && !userPaused && !autoplayBlocked &&
      currentChannel && els.video.paused
    ) {
      attemptPlay();
    }
  }

  function maybeRefreshEpg() {
    if (!currentChannel) return;
    const id = currentChannel.id;
    if (lastEpg && lastEpg.channelId === id && Date.now() - (lastEpg.fetchedAt || 0) < 60_000) return;
    loadEpg(id);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onLifecycleSync();
  });
  window.addEventListener('pageshow', (e) => {
    onLifecycleSync(true);
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(stallTimer);
  });
  window.addEventListener('online', () => onLifecycleSync(true));
  window.addEventListener('offline', () => {
    els.connDot.className = 'conn-dot off';
  });

  // ------------------------------------------------------------ media session
  function clearMediaSession() {
    lastMediaSessionChannelId = null;
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.metadata = null; } catch { /* unsupported */ }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    if (!currentChannel) {
      clearMediaSession();
      return;
    }
    if (lastMediaSessionChannelId === currentChannel.id) return;
    lastMediaSessionChannelId = currentChannel.id;
    try {
      const artwork = [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ];
      if (currentChannel.logo) artwork.unshift({ src: currentChannel.logo, sizes: 'any', type: 'image/png' });
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentChannel.name || 'Aerial',
        artist: 'Live' + (currentChannel.categoryName ? ' · ' + currentChannel.categoryName : ''),
        album: 'Aerial',
        artwork,
      });
    } catch { /* MediaMetadata unsupported */ }
    if (mediaSessionActionsBound) return;
    mediaSessionActionsBound = true;
    try { navigator.mediaSession.setActionHandler('play', () => attemptPlay()); } catch { /* unsupported */ }
    try { navigator.mediaSession.setActionHandler('pause', () => { if (els.video) els.video.pause(); }); } catch { /* unsupported */ }
    try { navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10)); } catch { /* unsupported */ }
    try { navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10)); } catch { /* unsupported */ }
  }

  function seekBy(delta) {
    const v = els.video;
    if (!v) return;
    try {
      const seekable = v.seekable;
      if (seekable && seekable.length > 0) {
        const target = Math.min(
          Math.max(v.currentTime + delta, seekable.start(0)),
          seekable.end(seekable.length - 1),
        );
        v.currentTime = target;
      }
    } catch { /* live stream without seekable range */ }
  }

  // ------------------------------------------------------------------- EPG --
  async function loadEpg(channelId) {
    if (!adapter || !channelId) return;
    const req = ++epgReq;
    try {
      const list = await getEpgForChannel(channelId);
      if (req !== epgReq || !currentChannel || currentChannel.id !== channelId) return; // stale
      lastEpg = { channelId, list, fetchedAt: Date.now() };
      renderEpgNow();
      renderGuide();
    } catch {
      if (req !== epgReq) return;
      lastEpg = { channelId, list: [], fetchedAt: Date.now() };
      renderEpgNow();
      renderGuide();
    }
  }

  async function getEpgForChannel(channelId) {
    if (adapter instanceof XtreamAdapter) {
      // Xtream get_short_epg expects the numeric stream_id (= channel.id).
      // epg_channel_id/tvg-id are XMLTV-style identifiers and wrong here.
      return adapter.getEPG(channelId);
    }
    if (adapter instanceof M3UAdapter) {
      const epgUrl = adapter.getEpgUrl();
      if (!epgUrl) return [];
      if (!xmltvParsed || Date.now() - xmltvFetchedAt > XMLTV_REFRESH_MS) {
        const text = await fetchXmltv(epgUrl);
        xmltvParsed = parseXMLTV(text);
        xmltvFetchedAt = Date.now();
      }
      // XMLTV is keyed by tvg-id; fall back to the channel id.
      const channel = channels.find((c) => c.id === channelId);
      const key = (channel && (channel.tvgId || channel.id)) || channelId;
      return shortEpg(xmltvParsed, key);
    }
    return [];
  }

  function renderEpgNow() {
    const list = lastEpg ? lastEpg.list : [];
    if (!list.length) {
      els.epgPanel.classList.add('hidden');
      return;
    }
    els.epgPanel.classList.remove('hidden');
    const now = list[0];
    els.epgNowTitle.textContent = now.title || '—';
    els.epgNowTime.textContent = epgRange(now);
    const next = list[1];
    els.epgNext.textContent = next
      ? `Danach · ${epgRange(next)} · ${next.title || ''}`
      : '';
  }

  function renderGuide() {
    const list = lastEpg ? lastEpg.list : [];
    els.guideChannel.textContent = currentChannel ? currentChannel.name : 'Kein Sender aktiv';
    els.guideList.innerHTML = '';

    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = currentChannel
        ? 'Kein Programm verfügbar'
        : 'Wähle einen Sender, um das Programm zu sehen.';
      els.guideList.appendChild(div);
      return;
    }

    list.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'guide-item' + (i === 0 ? ' now' : '');
      row.style.animationDelay = `${Math.min(200, i * 40)}ms`;

      const time = document.createElement('div');
      time.className = 'guide-time';
      time.textContent = epgStartTime(item);

      const body = document.createElement('div');
      body.className = 'guide-item-body';
      const title = document.createElement('div');
      title.className = 'guide-item-title';
      title.textContent = item.title || '—';
      body.appendChild(title);
      if (item.description) {
        const desc = document.createElement('div');
        desc.className = 'guide-item-desc';
        desc.textContent = item.description;
        body.appendChild(desc);
      }

      row.appendChild(time);
      row.appendChild(body);

      if (i === 0) {
        const badge = document.createElement('span');
        badge.className = 'guide-now-badge';
        badge.textContent = 'JETZT';
        row.appendChild(badge);
      }

      els.guideList.appendChild(row);
    });
  }

  function epgStartTime(e) {
    const t = e && (e.startTimestamp || e.start);
    return t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  }

  function epgRange(e) {
    if (!e) return '';
    const start = e.startTimestamp || e.start;
    const end = e.stopTimestamp || e.end;
    const f = (t) => (t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    const s = f(start);
    const en = f(end);
    return s && en ? `${s}–${en}` : s;
  }

  // ----------------------------------------------------------- player events
  els.playOverlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    markUserInteracted();
    attemptPlay();
  });

  els.playerRetryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    markUserInteracted();
    hidePlayerError();
    recoveryAttempts = 0;
    recover();
  });

  // ------------------------------------------------------------ search etc --
  els.searchInput.addEventListener('input', () => {
    search = els.searchInput.value;
    els.searchClear.classList.toggle('hidden', !search);
    // Filtering 50k+ channels per keystroke is wasteful — debounce.
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderChannels(), 200);
  });

  els.searchClear.addEventListener('click', () => {
    search = '';
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    els.searchInput.focus();
    renderChannels();
  });

  els.favToggle.addEventListener('click', () => {
    favOnly = !favOnly;
    updateFavToggle();
    renderChannels();
  });

  // ------------------------------------------------------------------ boot --
  (async function boot() {
    // Open app mode (server: AUTH_OPEN=true): skip the app login entirely.
    if (window.__AERIAL_AUTH_MODE === 'open' && window.__AERIAL_OPEN_ROLE) {
      enterApp(window.__AERIAL_OPEN_ROLE);
      return;
    }
    try {
      const me = await api('/api/auth/me');
      if (me.authenticated && me.role) enterApp(me.role);
      else showLogin();
    } catch {
      showLogin();
    }
  })();
})();
