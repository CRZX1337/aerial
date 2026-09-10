# Contributing to Aerial

Thanks for your interest in improving Aerial!

## Ground rules

- **Aerial is a player, not a provider.** It never hosts, proxies, or bundles
  IPTV content. Features that turn it into a relay/hosting service are out of
  scope by design.
- **No security regressions.** Provider credentials must never reach the
  server, logs, or error messages. Keep the CSP strict (no `unsafe-inline`,
  no `unsafe-eval`).
- **No silent failures.** Every `play()` call, every fetch, every recovery
  path needs defined handling and a user-understandable error state.

## Development setup

```bash
git clone https://github.com/CRZX1337/aerial.git
cd aerial
npm install
npm run dev          # start with auto-reload (http://localhost:8080)
```

For a provider to test against, use the bundled mock (CORS-enabled):

```bash
node scripts/mock-xtream.js 8090
# In the app: add Xtream profile → host http://127.0.0.1:8090, user "user", pass "pass"
```

## Tests

Run the full suite before opening a PR:

```bash
npm test
```

The suite covers auth, provider adapters (Xtream/M3U/XMLTV), PWA assets,
security (CSP, cookies, removed endpoints), and end-to-end flows.
New features need tests; bug fixes need a regression test.

## Project layout

```
src/                 server: auth, static hosting, security headers (no streaming!)
public/              client app (vanilla ES modules, no build step)
  js/providers/      Xtream / M3U / XMLTV adapters (client → provider, direct)
  vendor/            hls.js (vendored, see THIRD_PARTY_NOTICES.md)
test/                node:test suites
scripts/             mock provider, icon generator
assets/              brand master (logo.svg)
```

Keep the stack vanilla — no bundler, no framework, no TypeScript. The
zero-build setup is a feature.

## Branding

The brand mark (`assets/logo.svg`) is the single source of truth for all app
icons. If it ever changes, regenerate the icon set on Windows:

```bash
npm run icons        # powershell -File scripts/generate-icons.ps1
```

## Pull requests

1. Fork, create a feature branch (`feat/…`, `fix/…`).
2. Make your change, keep diffs focused.
3. `npm test` green, no console errors in the app.
4. Describe **what** and **why** — the reviewer should not need to reverse
  engineer your diff.
5. Never commit secrets, `.env` files, or `data/` contents.

## Reporting security issues

Please do **not** open public issues for security problems — see
[SECURITY.md](SECURITY.md).
