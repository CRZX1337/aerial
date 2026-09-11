/**
 * auth-mode.js — runs before the app module.
 * Asks the server once how the app gate is configured:
 *   - AUTH_OPEN=true on the server  -> app opens directly, no login screen.
 *     Users bring their OWN provider credentials client-side (never sent here).
 *   - otherwise                     -> classic app login (admin/user passkeys).
 */
(function () {
  window.__AERIAL_AUTH_MODE = 'login';
  window.__AERIAL_OPEN_ROLE = null;

  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (me && me.authMode === 'open' && me.authenticated) {
        window.__AERIAL_AUTH_MODE = 'open';
        window.__AERIAL_OPEN_ROLE = me.role || 'user';
      }
    })
    .catch(function () { /* classic login flow stays the fallback */ });
})();