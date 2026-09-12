import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { ROOT_DIR } from './config.js';
import { relayFetch, RelayError } from './relay.js';

const SESSION_COOKIE = 'aerial_session';

/**
 * Content-Security-Policy for the player model: app code is strictly
 * same-origin (no inline scripts/styles — the important XSS surface),
 * while media/images/connect must allow ARBITRARY origins because the
 * user's own IPTV provider is chosen at runtime and is streamed directly
 * by the browser (native HLS or hls.js). blob: is required for MSE media.
 * Mixed-content rules still apply (HTTPS app + HTTP provider is blocked
 * by the browser itself — correctly so).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' http: https: data:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' http: https:",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function readSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === SESSION_COOKIE) return value || null;
  }
  return null;
}

function setSessionCookie(res, token, ttlMs, secure) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
  );
}

export function buildApp({ auth, config = {}, sessionTtlMs }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Honour X-Forwarded-* headers only when explicitly configured
  // (TRUST_PROXY in .env). Default: off — headers cannot be spoofed.
  if (config.trustProxy !== undefined && config.trustProxy !== false) {
    app.set('trust proxy', config.trustProxy);
  }

  // Security headers on every response.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  // Attach the authenticated Aerial session (if any) to every request.
  app.use((req, res, next) => {
    const token = readSessionToken(req);
    req.session = token ? auth.getSession(token) : null;
    req.sessionToken = token;
    next();
  });

  // COOKIE_SECURE: 'auto' (default) adds the Secure flag when the request
  // arrived via HTTPS (directly or behind a proxy); true/false force it.
  // A spoofed X-Forwarded-Proto over plain HTTP only makes the browser
  // reject the Secure cookie for the attacker — not a bypass.
  function shouldSetSecureCookie(req) {
    if (config.cookieSecure === true) return true;
    if (config.cookieSecure === false) return false;
    const proto = req.headers['x-forwarded-proto'];
    return Boolean(req.secure) || (typeof proto === 'string' && proto.split(',')[0].trim() === 'https');
  }

  // ---- auth (Aerial app account — strictly separate from IPTV profiles) ----
  app.post('/api/auth/login', (req, res) => {
    const { role, password } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = auth.login(role, password, ip);
    if (!result.ok) {
      const status = result.reason === 'rate_limited' ? 429 : 401;
      return res.status(status).json({ error: result.reason });
    }
    setSessionCookie(res, result.token, sessionTtlMs, shouldSetSecureCookie(req));
    res.json({ ok: true, role: result.role });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) auth.logout(req.sessionToken);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    );
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    // Open app mode (AUTH_OPEN=true): no app login gate — report the fixed
    // 'user' role so the client boots straight into the player UI.
    if (config.authOpen) {
      return res.json({ authenticated: true, role: 'user', authMode: 'open' });
    }
    res.json({
      authenticated: Boolean(req.session),
      role: req.session ? req.session.role : null,
    });
  });

  // ---- provider relay (opt-in; same pattern as IPTVnator's web backend) ----
  // The user's own server fetches a provider URL and streams it back. This
  // bypasses browser limits that kill 20+ MB catalog downloads (tab
  // throttling) and bundles provider traffic for max_connections=1 accounts.
  // URLs (which contain provider credentials) are NEVER logged.
  app.post('/api/relay', (req, res) => {
    const authed = config.authOpen || Boolean(req.session);
    if (!authed) return res.status(401).json({ error: 'unauthorized' });
    const url = req.body && req.body.url;
    if (typeof url !== 'string' || !url) {
      return res.status(400).json({ error: 'bad_request', message: 'url required' });
    }

    relayFetch(url).then(
      (upstream) => {
        res.status(upstream.status);
        // Forward only media-relevant headers; drop set-cookie & friends.
        const ct = upstream.headers['content-type'];
        if (ct) res.setHeader('Content-Type', ct);
        const cl = upstream.headers['content-length'];
        if (cl) res.setHeader('Content-Length', cl);
        res.setHeader('Cache-Control', 'no-store');
        if (upstream.empty || !upstream.body) {
          res.end();
          return;
        }
        const body = upstream.body;
        res.setHeader('X-Aerial-Relay', '1');
        const close = () => {
          body.destroy();
        };
        res.on('close', close);
        body.on('error', () => {
          close();
          if (!res.headersSent) res.status(502).json({ error: 'relay_network' });
          else res.end();
        });
        body.pipe(res);
      },
      (err) => {
        if (err instanceof RelayError) {
          return res.status(err.status).json({ error: err.code, message: err.message });
        }
        res.status(500).json({ error: 'relay_failed' });
      },
    );
  });

  // ---- PWA manifest -----------------------------------------------------------
  app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(ROOT_DIR, 'public', 'manifest.webmanifest'));
  });

  // ---- static frontend ------------------------------------------------------
  app.use(
    express.static(path.join(ROOT_DIR, 'public'), {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        const p = String(filePath).split(path.sep).join('/');
        if (p.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/vendor\/|\.(js|css|png|svg|webmanifest|ico|woff2?)$/.test(p)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    }),
  );

  // ---- 404 + error handling --------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_json' });
    }
    console.error('[aerial] unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
