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

  // Player-model app shell: onboarding, unlock, profiles
  assert.match(html, /id="onboard-view"/);
  assert.match(html, /data-type="xtream"/);
  assert.match(html, /data-type="m3u"/);
  assert.match(html, /id="unlock-view"/);
  assert.match(html, /id="unlock-form"/);
  assert.match(html, /data-pane="profiles"/);
  assert.match(html, /id="profile-modal-backdrop"/);
  assert.match(html, /id="profile-form"/);

  // Exactly one video element (single stream, no parallel players)
  assert.equal((html.match(/<video/g) || []).length, 1);
  // No inline styles or scripts (CSP keeps style-src/script-src 'self')
  assert.doesNotMatch(html, /style="[^"]*"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);

  // App entry is an ES module (cache-busted)
  assert.match(html, /<script type="module" src="\/app\.js\?v=9">/);
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

  // Video error/stall listeners
  assert.match(js, /video\.addEventListener\('error'/);
  assert.match(js, /video\.addEventListener\('stalled'/);
  assert.match(js, /video\.addEventListener\('waiting'/);
  assert.match(js, /video\.addEventListener\('playing'/);
  assert.match(js, /video\.addEventListener\('canplay'/);

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

  // Onboarding hands the probed adapter to connectProfile (no double fetch)
  assert.match(js, /adapter, \/\/ reuse the probed catalog/);

  // Connection diagnostics: https auto-upgrade + precise failure causes
  assert.match(js, /import \{ diagnoseFailure, httpsTwin \} from '\.\/js\/providers\/netcheck\.js\?v=9'/);
  assert.match(js, /function connectWithDiagnosis\(/);
  assert.match(js, /const twin = httpsTwin\(host\)/);
  assert.match(js, /diagnosisMessage/); // precise cause overrides generic message
  assert.match(js, /Verbunden über HTTPS/); // user feedback on upgrade
  assert.match(js, /attemptConnect\(/); // single shared connect sequence
  // Adapter fetches are bounded (no infinite spinners on hung connections)
  assert.match(fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'xtream.js'), 'utf8'), /AbortSignal\.timeout/);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'm3u.js'), 'utf8'), /AbortSignal\.timeout/);
});

test('provider modules implement the adapter interface cleanly', () => {
  const xtream = fs.readFileSync(path.join(PUBLIC, 'js', 'providers', 'xtream.js'), 'utf8');
  for (const m of [
    'async authenticate()',
    'async getChannels()',
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
  assert.match(src, /aerial_recent_/);
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
  // Onboarding / profile / modal styles
  assert.match(css, /\.type-card/);
  assert.match(css, /\.profile-card/);
  assert.match(css, /\.modal-backdrop/);
  assert.match(css, /\.error-card/);
});
