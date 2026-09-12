<p align="center">
  <img src="public/icons/icon-192.png" width="96" height="96" alt="Aerial logo" />
</p>

<h1 align="center">Aerial</h1>

<p align="center">
  <strong>A sleek, privacy-first IPTV player PWA. Bring your own provider.</strong><br/>
  Xtream Codes · M3U / M3U8 · XMLTV EPG · native HLS on iOS
</p>

<p align="center">
  <a href="https://github.com/CRZX1337/aerial/actions/workflows/ci.yml"><img src="https://github.com/CRZX1337/aerial/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-green.svg" alt="Node >= 20" /></a>
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Android%20%7C%20Desktop-9cf" alt="Platforms" />
</p>

---

**Aerial is a player, not a provider.** It hosts no streams, maintains no
channel catalog, and proxies nothing. You connect your own IPTV subscription
— the app talks **directly from your browser to your provider**. No
credentials ever reach an Aerial server.

```
Your browser (Aerial PWA)
├──► Aerial server: app login, app shell, security headers   (sees no provider data)
└──► Your IPTV provider: catalog, EPG, live stream           (direct connection)
```

## ✨ Features

- **Bring your own provider** — multiple IPTV profiles with an onboarding
  wizard, live connection test, and instant switching
- **Provider formats** — [Xtream Codes API](https://wiki.xtream-codes.com/), M3U/M3U8
  playlists, XMLTV EPG (gzip-compressed guides supported)
- **Real player engineering** — native HLS on iOS/Safari, hls.js elsewhere,
  bounded error recovery with exponential backoff, autoplay-block handling
  ("tap to play"), Media Session (lock screen / Control Center)
- **Native-feeling PWA** — install to your home screen: standalone window,
  generated icon set, dark first paint, Dynamic Island / Home Indicator
  safe areas, app-resume and network-switch recovery
- **Per-profile data** — favorites and recently watched are tied to each
  provider profile; switching providers never mixes data
- **Lean & private** — zero build step, two dependencies, strict CSP,
  provider passwords stored only on explicit opt-in on your device

## 🚀 Quick start

```bash
git clone https://github.com/CRZX1337/aerial.git
cd aerial
npm install
npm start
```

On first start Aerial prints two randomly generated app passwords
(admin/user) **once** to the terminal — store them. They are then kept only
as scrypt hashes in `data/auth.json` (gitignored). Regenerate by deleting
the `data/` directory.

Open `http://localhost:8080`, log in, add your IPTV profile — done.

### Trying it without a real provider

A CORS-enabled mock Xtream server is bundled:

```bash
node scripts/mock-xtream.js 8090
npm start
# In the app: add Xtream profile → http://127.0.0.1:8090, user "user", pass "pass"
```

## 📡 Provider support & browser compatibility

Because Aerial connects **directly** to your provider, browser rules apply:

| Scenario | Works? |
| --- | --- |
| iOS / Safari — HLS stream URL in `<video>` | ✅ media playback needs no CORS |
| Other browsers — hls.js fetches playlists/segments | ⚠️ only if your provider sends CORS headers (many Xtream panels do) |
| Xtream `player_api.php` (catalog/EPG), M3U & XMLTV fetches | ⚠️ provider/hosting dependent (CORS) |
| HTTPS app + HTTP provider | ❌ blocked by the browser (mixed content) |
| Raw MPEG-TS (`.ts`) streams | ✅ Safari native · ❌ Chromium/Firefox (clear error message) |

Aerial detects all of these and shows **clear, actionable German error
messages** instead of silent failures. There is deliberately **no** CORS
bypass, `no-cors` hack, or hidden relay — a provider that refuses browser
connections simply cannot be used from the browser.

### Automatic connection diagnostics & resilient catalogs

When a connection fails, Aerial does not just say "network error":

1. **Fast connect, resilient catalog:** the connect wizard only checks
   credentials + categories (two small requests, seconds). The channel
   list loads afterwards with visible progress — first as one big
   transfer (two attempts, 2–3 minute budgets), and when the route keeps
   killing that 20+ MB download, automatically **category by category**:
   hundreds of small ~20 KB requests that survive unstable routes and
   flaky provider edges. Failed categories are tolerated and reported
   ("Senderliste teilweise geladen"), progress is shown live
   ("lädt kategorie-weise … 400/916 Kategorien").
2. **HTTPS auto-upgrade:** if the entered provider URL is `http://` and the
   connection fails at the transport level, the `https://` twin is tried
   automatically. Many Cloudflare-fronted providers serve the same API over
   both — and `https` survives HTTPS deployments and stricter networks.
   The upgraded URL is stored in the profile.
3. **Staged diagnosis with throughput measurement:** if everything fails,
   Aerial re-runs the provider's real request sequence (login →
   categories → channel list), reads the first 256 KB of the channel list
   to **measure your actual download speed**, and pinpoints the failing
   step and its actual cause on *your* device — mixed content, a timeout
   on a slow link (including a concrete estimate like *"~40 KB/s — the
   channel list needs ~9 min, this connection won't suffice"*), network
   blocks (DNS filter, firewall, adblocker), or a provider/WAF that blocks
   browsers — and shows the matching fix plus a **clickable self-test
   link** that opens the provider's real API URL in a new tab (data =
   report an app bug; block/challenge page = the provider or your network
   blocks the request).

**Troubleshooting a failed connection:**
- App served over **https://** and provider URL is **http://** → use the
  provider's **https** URL (the browser blocks mixed content, no app can
  change that)
- "Zeitüberschreitung bei „Senderliste"" or partial catalog warnings →
  your route to the provider is slow/unstable for big transfers; Aerial
  automatically retries category-by-category — keep the app open, use
  stable Wi-Fi, or try a VPN (different routing)
- Provider works in a native IPTV app but not in Aerial → that app has no
  CORS rules; disable adblocker extensions for the app, try the self-test
  link from the error message, or a different network
- Provider serves both `http://` and `https://` → prefer `https://`

## ⚙️ Configuration (`.env`)

Copy [`.env.example`](.env.example) to `.env`. Everything is optional:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `SESSION_TTL_MS` | `86400000` | App session lifetime (24 h) |
| `COOKIE_SECURE` | `auto` | Session cookie `Secure` flag: `auto` (set on HTTPS), `true`, `false` |
| `TRUST_PROXY` | `false` | Express `trust proxy` (hops/`loopback`/CIDR) behind a reverse proxy |
| `LOGIN_MAX_ATTEMPTS` | `8` | Failed logins per IP before `429` |
| `LOGIN_WINDOW_MS` | `300000` | Rate-limit window (5 min) |
| `AUTH_OPEN` | `false` | Open app mode: skip the app login gate — the app opens directly; users configure their own providers client-side |

## 🔐 Security model

- **Provider credentials never touch the Aerial server.** They live in your
  browser: in-memory by default; persisted only when you explicitly enable
  *"save on this device"* per profile. Logout drops in-memory secrets;
  opt-in secrets remain (your choice, your device).
- **localStorage risk assessment** (deliberate trade-off): profiles must
  survive app restarts while the server must never see the data — that
  leaves client-side persistence. Protections: per-profile keys, opt-in
  secrets only, strict CSP (`script-src 'self'`, no `unsafe-inline`) which
  makes XSS practically impossible, `referrerPolicy: no-referrer` on
  provider logos, no third-party scripts. Residual risk: a same-origin XSS
  could read opt-in secrets. Possible future upgrade: WebCrypto-encrypted
  storage with a passphrase-derived key.
- **App login ≠ IPTV accounts.** The Aerial login (admin/user, scrypt
  hashes, per-IP rate limiting) only gates the app itself.
- **Strict CSP** — app code is same-origin only; `media-src`/`connect-src`/
  `img-src` intentionally allow arbitrary origins because *your* provider is
  chosen at runtime. Browser mixed-content rules stay in effect.
- Full policy and reporting: [SECURITY.md](SECURITY.md)

## 🧪 Development

```bash
npm test     # 39 tests: auth, provider adapters, PWA assets, security, e2e
npm run dev  # auto-reload dev server
```

The stack is intentionally vanilla: **no bundler, no framework, no
TypeScript**. Zero build step is a feature.

```
src/                  server: login, static hosting, security headers (no streaming)
public/
  index.html          app shell (login, onboarding, player, profiles)
  app.js              client app (ES module): profiles, player, EPG, lifecycle
  js/providers/       Xtream / M3U / XMLTV adapters (client → provider, direct)
  js/profiles.js      profile store (opt-in secrets, per-profile data)
  vendor/             hls.js 1.7.0 (vendored — see THIRD_PARTY_NOTICES.md)
test/                 node:test suites
scripts/              mock provider, icon generator
assets/               brand master (logo.svg)
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Changelog: [CHANGELOG.md](CHANGELOG.md).

## 📝 Disclaimer

Aerial does not host, sell, or provide IPTV subscriptions and does not ship
any content, playlists, or channels. Users connect their own providers and
are responsible for complying with their provider's terms and applicable
law.

## 📄 License

Released under the [MIT License](LICENSE) © 2026 CRZX1337.
Vendored [hls.js](https://github.com/video-dev/hls.js) is Apache-2.0 — see
[public/vendor/THIRD_PARTY_NOTICES.md](public/vendor/THIRD_PARTY_NOTICES.md).
