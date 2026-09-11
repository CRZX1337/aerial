# Changelog

All notable changes to Aerial are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Open app mode (`AUTH_OPEN=true`)** — run Aerial without the app login
  gate: the player opens directly and every user enters their own provider
  credentials client-side (the server never sees them). Opt-in via env,
  fully reversible; classic admin/user login remains available and all
  auth endpoints are untouched. Boot order is guaranteed by a tiny
  `auth-mode.js` bootstrap that runs before the app module.

### Fixed

- `package-lock.json` was stale from the pre-rebrand name (`hoodtv`);
  regenerated to match `aerial` 0.1.0.

## [0.1.0] - 2026-09-10

Initial public release.

### Added

- **Bring-your-own-provider IPTV player** — Aerial hosts no streams and
  proxies nothing; the browser talks to the user's own provider directly.
- **Provider support:** Xtream Codes API, M3U/M3U8 playlists, XMLTV EPG
  (incl. transparent gzip decompression).
- **Profile system:** multiple IPTV accounts with onboarding wizard,
  connection test, edit/switch/delete, per-profile favorites and
  recently-watched.
- **Player:** native HLS on iOS/Safari, hls.js 1.7.0 elsewhere, bounded
  error recovery with exponential backoff, autoplay-block overlay,
  Media Session integration (lock screen / Control Center).
- **PWA / iOS:** installable app shell (standalone), generated icon set
  incl. maskable variants, dark first paint, safe-area support
  (Dynamic Island / Home Indicator), lifecycle re-sync
  (`visibilitychange`/`pageshow`/`pagehide`/`online`/`offline`).
- **App account:** separate admin/user login (scrypt hashes, generated
  credentials, per-IP rate limiting) — strictly separated from IPTV
  provider accounts.
- **Security:** strict CSP (no `unsafe-inline`/`unsafe-eval`), HttpOnly
  `SameSite=Lax` cookies with configurable `Secure` flag, provider
  credentials never touch the server, opt-in local storage of provider
  secrets.
- **Test suite:** 39 tests across auth, provider adapters, PWA assets,
  security, and end-to-end flows (`npm test`).
- Bundled CORS-enabled mock Xtream provider for local testing.
