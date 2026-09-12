import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ------------------------------------------------------------- manifest -----

test('manifest.webmanifest is valid and complete', () => {
  const raw = fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, 'Aerial');
  assert.equal(manifest.short_name, 'Aerial');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#06060a');
  assert.equal(manifest.background_color, '#06060a');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
  const purposes = manifest.icons.map((i) => i.purpose);
  assert.ok(purposes.includes('any'));
  assert.ok(purposes.includes('maskable'));
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/icons/'));
    assert.ok(fs.existsSync(path.join(PUBLIC, icon.src.slice(1))), `${icon.src} exists`);
    assert.match(icon.sizes, /^\d+x\d+$/);
  }
});

// ----------------------------------------------------------------- icons -----

test('all app icons exist with correct square dimensions', () => {
  const expected = {
    'favicon-32.png': 32,
    'apple-touch-icon.png': 180,
    'icon-192.png': 192,
    'icon-512.png': 512,
    'icon-192-maskable.png': 192,
    'icon-512-maskable.png': 512,
  };
  for (const [name, size] of Object.entries(expected)) {
    const file = path.join(PUBLIC, 'icons', name);
    assert.ok(fs.existsSync(file), `${name} exists`);
    const { width, height } = readPngSize(file);
    assert.equal(width, size, `${name} width`);
    assert.equal(height, size, `${name} height`);
  }
});

test('brand assets: SVG master mark exists and icons are derived from it', () => {
  // assets/logo.svg is the single source of truth for the brand mark.
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');
  assert.match(svg, /aerial-grad/);
  assert.match(svg, /#8b5cf6/);
  assert.match(svg, /#4f7cff/);
  assert.match(svg, /#2dd4ff/);
  assert.match(svg, /<polygon[^>]*fill="#fff"/);

  // The icon generator script is committed so the PNG set is reproducible.
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-icons.ps1'), 'utf8');
  assert.match(gen, /FromArgb\(139, 92, 246\)/);
  assert.match(gen, /FromArgb\(45, 212, 255\)/);
  assert.match(gen, /favicon-32\.png/);
  assert.match(gen, /icon-512-maskable\.png/);
});

// -------------------------------------------------------------- index.html ---

test('index.html has complete iOS/PWA metadata and the player app shell', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  // PWA links
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"\s*\/?>/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon\.png"\s*\/?>/);
  assert.match(html, /<link rel="icon"[^>]*favicon-32\.png/);

  // iOS standalone + status bar + viewport
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"\s*\/?>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"\s*\/?>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Aerial"\s*\/?>/);
  assert.match(html, /viewport-fit=cover/);

  // Dark first paint (no white flash on launch)
  assert.match(html, /<meta name="color-scheme" content="dark"\s*\/?>/);

  // Native-like video playback
  assert.match(html, /<video[^>]*playsinline/);
  assert.match(html, /webkit-playsinline/);

  // Player overlays for autoplay-block / stream errors
  assert.match(html, /id="play-overlay"/);
  assert.match(html, /id="play-overlay-btn"/);
  assert.match(html, /id="player-error"/);
  assert.match(html, /id="player-retry-btn"/);

  // Unified premium player: one card, custom controls, no native controls
  assert.match(html, /class="player-card glass"/);
  assert.match(html, /id="player-shell"/);
  assert.match(html, /id="player-controls"/);
  assert.match(html, /id="pc-play"/);
  assert.match(html, /id="pc-mute"/);
  assert.match(html, /id="pc-volume"/);
  assert.match(html, /id="pc-fullscreen"/);
  assert.match(html, /id="player-logo"/);
  assert.doesNotMatch(html, /<video[^>]*\scontrols\b/); // custom UI, not the browser's
  // Info bar integrates channel identity + EPG + actions in one card
  assert.match(html, /class="player-info"/);
  assert.match(html, /class="player-info-main"/);
  assert.match(html, /class="player-actions"/);

  // Player-model app shell: onboarding, unlock, profiles
  assert.match(html, /id="onboard-view"/);
  assert.match(html, /data-type="xtream"/);
  assert.match(html, /data-type="m3u"/);
  assert.match(html, /id="unlock-view"/);
  assert.match(html, /id="unlock-form"/);
  assert.match(html, /data-pane="profiles"/);
  assert.match(html, /id="profile-modal-backdrop"/);
  assert.match(html, /id="profile-form"/);

  // Browse pane: vertical category navigation in its own section
  assert.match(html, /class="cat-section"/);
  assert.match(html, /class="section-label" id="cat-section-label">Kategorien/);
  assert.match(html, /id="category-chips" class="category-list"/);
  assert.match(html, /class="section-label sender-label">Sender/);

  // Settings: channel-name display modes (segmented control, 4 options)
  assert.match(html, /class="settings-card glass"/);
  assert.match(html, /id="namemode-seg"/);
  for (const mode of ['auto', 'one', 'two', 'full']) {
    assert.match(html, new RegExp(`data-mode="${mode}"`), `mode button ${mode}`);
  }

  // Exactly one video element (single stream, no parallel players)
  assert.equal((html.match(/<video/g) || []).length, 1);
  // No inline styles or scripts (CSP keeps style-src/script-src 'self')
  assert.doesNotMatch(html, /style="[^"]*"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);

  // App entry is an ES module (cache-busted)
  assert.match(html, /<script type="module" src="\/app\.js\?v=21">/);
  // Branding: Aerial
  assert.match(html, /<title>Aerial<\/title>/);
});

// ----------------------------------------------------------------- app.js ----

test('app.js implements autoplay + recovery + lifecycle without silent errors', () => {
  const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

  // No silent play() swallowing
  assert.doesNotMatch(js, /play\(\)\s*\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  assert.match(js, /function attemptPlay\(\)/);
  assert.match(js, /handlePlayFailure/);
  assert.match(js, /NotAllowedError/);

  // Bounded recovery with exponential backoff, coalesced
  assert.match(js, /MAX_RECOVERY_ATTEMPTS\s*=\s*5/);
  assert.match(js, /Math\.min\(8000,\s*500\s*\*\s*2\s*\*\*\s*recoveryAttempts\)/);
  assert.match(js, /recoveryPending/);
  // ... and recovery re-attach must NOT reset the budget (no infinite loop)
  assert.match(js, /if \(!opts\.isRecovery\) recoveryAttempts = 0/);
  assert.match(js, /attachPlayer\(channel, url, \{ isRecovery: true \}\)/);

  // Xtream EPG uses the stream_id (channelId), not the XMLTV-style tvg-id
  assert.match(js, /return adapter\.getEPG\(channelId\);/);

  // No window.confirm/alert/prompt anywhere: they are silently ignored by
  // iOS standalone PWAs (would break e.g. profile deletion in the app)
  assert.doesNotMatch(js, /window\.(confirm|alert|prompt)/);

  // Module graph integrity: every named import from profiles.js must exist
  // as an export in profiles.js. A mismatch makes the ENTIRE app.js module
  // fail to load (black screen) — happened when profiles.js gained new
  // exports but browsers served a stale cached copy under the old ?v param.
  const profilesSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'profiles.js'), 'utf8');
  const profilesImport = js.match(/import \{([^}]*)\} from '\.\/js\/profiles\.js\?v=\d+'/)[1];
  for (const name of profilesImport.split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.match(
      profilesSrc,
      new RegExp(`export function ${name}\\(`),
      `profiles.js must export ${name} (app.js imports it)`,
    );
  }

  // Video error/stall listeners
  assert.match(js, /video\.addEventListener\('error'/);
  assert.match(js, /video\.addEventListener\('stalled'/);
  assert.match(js, /video\.addEventListener\('waiting'/);
  assert.match(js, /video\.addEventListener\('playing'/);
  assert.match(js, /video\.addEventListener\('canplay'/);

  // Custom player controls: event-driven icons, auto-hide, iOS fallbacks
  assert.match(js, /function setupPlayerControls\(\)/);
  assert.match(js, /function wakeControls\(\)/);
  assert.match(js, /controls-idle/); // auto-hide class
  assert.match(js, /controlsForcedVisible\(\)/); // stay visible when paused/blocked/error
  assert.match(js, /els\.pcVolume\.style\.setProperty\('--fill'/); // volume fill
  assert.match(js, /requestFullscreen/);
  assert.match(js, /webkitRequestFullscreen/);
  assert.match(js, /webkitEnterFullscreen/); // iPhone native fallback
  assert.match(js, /fullscreenchange/);
  assert.match(js, /volume-unsupported/); // iOS hides scriptable-volume UI
  assert.match(js, /function setPlayerLogo\(channel\)/); // channel logo in player
  assert.match(js, /refreshControlsPresence\(\)/); // controls only with a channel
  // Icons reflect video state (single source of truth), not button clicks
  assert.match(js, /video\.addEventListener\('play', updatePlayIcon\)/);
  assert.match(js, /video\.addEventListener\('volumechange', updateVolumeUi\)/);
  // Tap on the video toggles playback (guarded against overlay states)
  assert.match(js, /els\.video\.addEventListener\('click'/);

  // Lifecycle sync (background/foreground, bfcache, network)
  assert.match(js, /addEventListener\('visibilitychange'/);
  assert.match(js, /addEventListener\('pageshow'/);
  assert.match(js, /addEventListener\('pagehide'/);
  assert.match(js, /addEventListener\('online'/);
  assert.match(js, /addEventListener\('offline'/);

  // Media Session with graceful fallback
  assert.match(js, /'mediaSession' in navigator/);
  assert.match(js, /new MediaMetadata\(/);
  assert.match(js, /setActionHandler\('play'/);
  assert.match(js, /setActionHandler\('pause'/);
  assert.match(js, /setActionHandler\('seekbackward'/);
  assert.match(js, /setActionHandler\('seekforward'/);

  // Single-stream invariant: one pipeline teardown before every attach
  assert.match(js, /function detachPipeline\(\)/);
  assert.match(js, /function stopPlayer\(\)/);

  // Provider race guards: stale responses cannot overwrite newer state
  assert.match(js, /connectToken/);
  assert.match(js, /token !== connectToken/);
  assert.match(js, /epgReq/);

  // Provider adapters wired client-side (direct connection model)
  assert.match(js, /XtreamAdapter/);
  assert.match(js, /M3UAdapter/);
  // ... and nothing still points at the old server-side proxy
  assert.doesNotMatch(js, /\/api\/stream\//);
  assert.doesNotMatch(js, /\/api\/control\//);
  assert.doesNotMatch(js, /EventSource/);

  // Render guards
  assert.match(js, /if \(!els\.channelList\) return/);
  assert.match(js, /if \(!currentChannel\) return/);

  // Windowed channel list: huge catalogs (50k+) never render as one tree
  assert.match(js, /PAGE_INITIAL\s*=\s*90/);
  assert.match(js, /PAGE_STEP\s*=\s*150/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /attachListSentinel/);
  assert.match(js, /appendChannelRange/);
  assert.match(js, /renderLimit/);
  assert.match(js, /listVersion \+= 1/);

  // Filter-signature guard: unchanged state = highlight update only
  assert.match(js, /renderedSignature/);
  assert.match(js, /updateActiveChannelHighlight/);
  assert.match(js, /card\.dataset\.id = c\.id/);

  // Debounced search for giant catalogs
  assert.match(js, /clearTimeout\(searchDebounce\)/);

  // Category chips are signature-guarded too (900+ categories)
  assert.match(js, /categoriesSignature/);
  // ... and render as a vertical icon list (never horizontal chips)
  assert.match(js, /row\.className = 'cat-item'/);
  assert.match(js, /CAT_ICON/);
  assert.match(js, /cat-glyph/);
  assert.match(js, /cat-name/);

  // Category favorites: pinned section, separate store, click isolation
  assert.match(js, /getCategoryFavorites/);
  assert.match(js, /saveCategoryFavorites/);
  assert.match(js, /function toggleCategoryFavorite\(id\)/);
  assert.match(js, /catFavorites = getCategoryFavorites\(id\)/); // loaded per profile
  assert.match(js, /\[...catFavorites\]\.join\(','\)/); // favorites invalidate the render signature
  assert.match(js, /buildCatSubLabel\('Favoriten'\)/); // pinned section header
  assert.match(js, /buildCatSubLabel\('Alle Kategorien'\)/);
  assert.match(js, /cat-sub-label/);
  // The star click must not select the category
  assert.match(js, /star\.addEventListener\('click', \(e\) => \{\r?\n\s+e\.stopPropagation\(\);/);
  // Rows are keyboard-accessible divs (a button cannot contain the star button)
  assert.match(js, /row\.setAttribute\('role', 'button'\)/);
  assert.match(js, /row\.addEventListener\('keydown'/);

  // Channel-name display modes: persisted setting, 4 modes, auto = viewport
  assert.match(js, /import \{[\s\S]*?getSetting,/); // settings imports exist (exact set checked by the module-graph test)
  assert.match(js, /NAME_MODES = \['auto', 'one', 'two', 'full'\]/);
  assert.match(js, /let nameMode = 'auto'/);
  assert.match(js, /getSetting\('nameMode', 'auto'\)/);
  assert.match(js, /setSetting\('nameMode', nameMode\)/);
  assert.match(js, /function applyNameMode\(\)/);
  assert.match(js, /AUTO_PHONE_MAX_VIEWPORT = 700/);
  assert.match(js, /'nm-' \+ resolvedNameMode\(\)/); // class toggle, no re-render
  assert.match(js, /window\.addEventListener\('resize'/); // auto follows rotation/resize
  assert.match(js, /NAME_MODES\.includes\(stored\)/); // invalid stored values fall back to auto

  // Onboarding hands the probed adapter to connectProfile (auth/categories
  // stay cached; the catalog loads once inside connectProfile)
  assert.match(js, /adapter, \/\/ reuse the probed adapter/);

  // Connection diagnostics: https auto-upgrade + staged failure analysis
  assert.match(js, /import \{ diagnoseStages, httpsTwin \} from '\.\/js\/providers\/netcheck\.js\?v=21'/);
  assert.match(js, /function connectWithDiagnosis\(/);
  assert.match(js, /const twin = httpsTwin\(host\)/);
  assert.match(js, /diagnosisMessage/); // precise cause overrides generic message
  assert.match(js, /Verbunden über HTTPS/); // user feedback on upgrade
  assert.match(js, /attemptConnect\(/); // single shared connect sequence
  assert.match(js, /await adapter\.getCategories\(\);/); // fast xtream probe: no catalog in the wizard
  // Timeouts are their own error class (slow link != network/CORS problem)
  assert.match(js, /function isTimeoutFailure\(err\)/);
  assert.match(js, /isNetworkFailure\(firstErr\)/); // https twin only for real network failures
  assert.match(js, /diagnoseStages\(stages\)/); // staged re-run: Anmeldung -> Kategorien -> Senderliste
  assert.match(js, /renderProviderError/); // error output incl. self-test link
  assert.match(js, /testUrl/); // clickable provider self-test URL
  // Resilient catalog loading: big transfer first, per-category fallback
  const xtreamSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'xtream.js'), 'utf8');
  assert.match(xtreamSrc, /AbortSignal\.timeout/); // bounded requests
  assert.match(xtreamSrc, /fetchFullStreams\(\)/);
  assert.match(xtreamSrc, /\[120_000, 180_000\]/); // two attempts for the 20+ MB list
  assert.match(xtreamSrc, /fetchStreamsByCategory\(/); // many small requests survive resets
  assert.match(xtreamSrc, /category_id: cat\.id/);
  assert.match(xtreamSrc, /catalog\.partial = partial/);
  assert.match(xtreamSrc, /catalog\.failedCategories = failedCategories/);
  // Small requests retry through transient edge blips; transport errors only
  assert.match(xtreamSrc, /fetchJsonRetry\(/);
  // Fallback stays at LOW concurrency (max_connections=1 accounts) with 3 attempts
  assert.match(xtreamSrc, /mapPool\(total, 2,/);
  assert.match(xtreamSrc, /attempt < 3/);
  // Empty catalogs are never cached — retries must re-attempt
  assert.match(xtreamSrc, /Never cache an empty catalog/);
  assert.match(xtreamSrc, /stageUrls\(\)/);
  assert.match(xtreamSrc, /probeBytes: 262_144/); // throughput measurement stage
  assert.match(fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'm3u.js'), 'utf8'), /one retry/);
  // Live progress + cancellation for the fallback in the app
  assert.match(js, /updateListProgress/);
  assert.match(js, /kategorie-weise/);
  assert.match(js, /list-progress/);
  assert.match(js, /Senderliste teilweise geladen/); // partial-catalog warning
  // "ok" diagnosis differentiates timeouts (slow link) from true transients
  assert.match(js, /function okDiagnosisMessage\(err, diag\)/);
  assert.match(js, /throughputKBs/);
  assert.match(js, /Diese Verbindung reicht dafür voraussichtlich nicht aus/);
  // ... and is stage-aware: auth/categories blips are NOT reported as
  // fallback failures
  assert.match(js, /kurzzeitig nicht erreichbar/);

  // Open-app-mode logout handling: no session to end -> button hidden,
  // and boot records the mode from its own /api/auth/me response BEFORE
  // enterApp runs (auth-mode.js probe can lose the race)
  assert.match(js, /window\.__AERIAL_AUTH_MODE = 'open';\r?\n\s+window\.__AERIAL_OPEN_ROLE/);
  assert.match(js, /if \(window\.__AERIAL_AUTH_MODE === 'open'\) \{\r?\n\s+els\.logoutBtn\.classList\.add\('hidden'\)/);

  // Provider relay (opt-in, IPTVnator-style web backend pattern)
  assert.match(js, /import \{ makeProviderFetch \} from '\.\/js\/providers\/relayfetch\.js\?v=21'/);
  assert.match(js, /useRelay: relaid/); // remember what worked
  assert.match(js, /useRelay: profile\.useRelay \|\| false/);
  assert.match(js, /retryViaRelay\(\)/); // catalog retry through own server
  assert.match(js, /Profil wurde auf Server-Relay umgestellt/);
  assert.match(js, /pmRelay/); // per-profile relay checkbox in the modal
  assert.match(js, /pm-relay-field/);
  const relaySrc = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'relayfetch.js'), 'utf8');
  assert.match(relaySrc, /\/api\/relay/);
  assert.match(relaySrc, /TypeError/); // relay failures classify as network errors
});

test('provider modules implement the adapter interface cleanly', () => {
  const xtream = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'xtream.js'), 'utf8');
  for (const m of [
    'async authenticate()',
    'async getChannels(onProgress, isCancelled)',
    'async getCategories()',
    'getStreamUrl(',
    'async getEPG(',
    'disconnect()',
  ]) {
    assert.ok(xtream.includes(m), `XtreamAdapter has ${m}`);
  }
  // Credentials only travel to the provider itself
  assert.match(xtream, /player_api\.php/);
  assert.doesNotMatch(xtream, /console\./);

  const m3u = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'm3u.js'), 'utf8');
  for (const m of ['async authenticate()', 'async getChannels()', 'getStreamUrl(', 'disconnect()']) {
    assert.ok(m3u.includes(m), `M3UAdapter has ${m}`);
  }
  assert.doesNotMatch(m3u, /console\./);

  const xmltv = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'xmltv.js'), 'utf8');
  assert.match(xmltv, /DecompressionStream/);
  assert.match(xmltv, /parseXmltvTime/);
  assert.doesNotMatch(xmltv, /console\./);
});

test('profiles.js keeps secrets opt-in and data namespaced per profile', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'profiles.js'), 'utf8');
  assert.match(src, /aerial_profiles/);
  assert.match(src, /aerial_secret_/);
  assert.match(src, /aerial_favs_/);
  assert.match(src, /aerial_catfavs_/); // category favorites: separate store
  assert.match(src, /aerial_recent_/);
  // profile deletion clears every per-profile key
  const delBlock = src.match(/function deleteProfile\(id\) \{[\s\S]*?\}/)[0];
  for (const key of ['KEY_SECRET', 'KEY_FAVS', 'KEY_CATFAVS', 'KEY_RECENT']) {
    assert.ok(delBlock.includes(key), `deleteProfile removes ${key}`);
  }
  // every storage helper is guarded (no crash without localStorage)
  for (const helper of ['function readJson(', 'function writeJson(', 'function removeKey(']) {
    const idx = src.indexOf(helper);
    assert.ok(idx !== -1, `profiles.js has ${helper}`);
    const body = src.slice(idx, idx + 400);
    assert.ok(body.includes('try {'), `${helper} guards storage access`);
  }
});

// -------------------------------------------------------------- styles.css ---

test('styles.css covers safe areas, dark scheme and app-like touch behaviour', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /html\s*\{[^}]*background:\s*#06060a/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /env\(safe-area-inset-left/);
  assert.match(css, /env\(safe-area-inset-right/);
  assert.match(css, /overscroll-behavior:\s*none/);
  assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /user-select:\s*none/);
  assert.match(css, /100dvh/);
  // Overlay styles for the two player states
  assert.match(css, /\.player-overlay/);
  assert.match(css, /\.play-overlay-btn/);
  // Unified premium player: card, custom controls, fullscreen support
  assert.match(css, /\.player-card/);
  assert.match(css, /\.player-controls/);
  assert.match(css, /\.pc-btn/);
  assert.match(css, /\.player-shell:fullscreen/);
  assert.match(css, /\.player-shell:-webkit-full-screen/);
  assert.match(css, /\.controls-idle \.player-controls/); // auto-hide
  assert.match(css, /\.player-logo/);
  assert.match(css, /\.player-info/);
  assert.match(css, /volume-unsupported \.pc-volume/); // iOS volume hidden
  // Category navigation: fully visible VERTICAL list (never horizontal scroll)
  const catListBlock = css.match(/\.category-list \{[\s\S]*?\}/)[0];
  assert.match(catListBlock, /flex-direction:\s*column/, 'vertical list');
  assert.match(catListBlock, /overflow-y:\s*auto/, 'vertical scrolling only');
  assert.match(catListBlock, /overflow-x:\s*hidden/, 'no horizontal overflow');
  assert.match(catListBlock, /overscroll-behavior:\s*contain/, 'no scroll chaining');
  assert.ok(/max-height:\s*clamp\(/.test(catListBlock), 'bounded height');
  const catItemBlock = css.match(/\.cat-item \{[^}]*border-radius: 11px;[^}]*\}/)[0];
  assert.match(catItemBlock, /min-height:\s*38px/, 'readable row height');
  assert.match(catItemBlock, /white-space:\s*nowrap/, 'no text wrapping/cut-off');
  assert.match(css, /\.cat-item\.active::before/, 'active entry: gradient indicator bar');
  assert.match(css, /\.section-label/, 'Kategorien/Sender section headers');
  // Category favorite stars + pinned sub-sections
  assert.match(css, /\.cat-star/);
  assert.match(css, /\.cat-star\.on svg path \{ fill: currentColor; \}/, 'pinned = filled star');
  assert.match(css, /\.cat-sub-label/);
  // Channel-name display modes: base stays single-line (readable, 14px),
  // two = clamp after 2 lines, full = wraps completely
  const nmTwo = css.match(/\.channel-list\.nm-two \.channel-name \{[^}]*\}/)[0];
  assert.match(nmTwo, /-webkit-line-clamp:\s*2/);
  assert.match(nmTwo, /white-space:\s*normal/);
  assert.match(nmTwo, /min-height:\s*2\.64em/, 'two-line rows align the category line');
  const nmFull = css.match(/\.channel-list\.nm-full \.channel-name \{[^}]*\}/)[0];
  assert.match(nmFull, /white-space:\s*normal/);
  assert.match(nmFull, /overflow-wrap:\s*break-word/);
  assert.ok(!/font-size/.test(nmTwo) && !/font-size/.test(nmFull), 'modes never shrink the font');
  // Settings segmented control
  assert.match(css, /\.settings-card/);
  assert.match(css, /\.seg button\.active/);
  assert.doesNotMatch(css, /\.category-chips\b/, 'horizontal chips are gone');
  const headBlock = css.match(/\.browser-head \{[\s\S]*?\}/)[0];
  assert.match(headBlock, /flex-shrink:\s*0/, 'search row protected');
  const catSectionBlock = css.match(/\.cat-section \{[\s\S]*?\}/)[0];
  assert.match(catSectionBlock, /flex-shrink:\s*0/, 'category section never squeezed');
  // Onboarding / profile / modal styles
  assert.match(css, /\.type-card/);
  assert.match(css, /\.profile-card/);
  assert.match(css, /\.modal-backdrop/);
  assert.match(css, /\.error-card/);
});
