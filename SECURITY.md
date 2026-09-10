# Security Policy

## Supported versions

Aerial is pre-1.0; security fixes land on `main` only.

## Reporting a vulnerability

Please report vulnerabilities privately:

1. Use GitHub's **"Report a vulnerability"** (Security → Advisories) on
   [CRZX1337/aerial](https://github.com/CRZX1337/aerial/security/advisories),
   or
2. Email the maintainer directly (see the repository owner profile).

Do **not** open a public issue for security problems. Please allow a
reasonable response window (typically 14 days) before public disclosure.

## Security model (summary)

- **Aerial never hosts or proxies IPTV content.** The server only serves the
  app shell, static assets, and the app login. All provider traffic
  (catalog, EPG, streams) flows directly from the user's browser to their
  own IPTV provider.
- **Provider credentials never reach the Aerial server.** They stay in the
  browser: in-memory by default, persisted only per explicit opt-in per
  profile (device-local).
- **App login ≠ provider accounts.** Sessions are HttpOnly cookies with
  `SameSite=Lax`, scrypt-hashed passwords, per-IP login rate limiting.
- **Strict CSP:** `script-src 'self'` (no inline/eval). `media-src`,
  `connect-src` and `img-src` intentionally allow arbitrary origins because
  the provider is user-chosen at runtime.
- **No CORS bypasses:** providers without CORS headers or HTTP-only
  providers behind an HTTPS deployment fail with clear error messages —
  by design, not by accident.

## Scope

In scope: the Aerial server (`src/`), the client app (`public/`), credential
handling, CSP/cookie/session handling.
Out of scope: vulnerabilities in third-party providers reachable from the
app, and generic browser XSS that the CSP already mitigates.
