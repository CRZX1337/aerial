// Profile store: the user's own IPTV connections, kept in localStorage on
// the user's device. the Aerial server never sees any of this data.
//
// Security model:
//  - profile metadata (name, type, host, username, EPG URL) persists per device
//  - provider passwords are kept in memory only, unless the user explicitly
//    opts in per profile ("remember on this device")
//  - favorites / recently watched are namespaced per profile id so switching
//    providers never mixes data

const KEY_PROFILES = 'aerial_profiles';
const KEY_ACTIVE = 'aerial_active_profile';
const KEY_SECRET = (id) => `aerial_secret_${id}`;
const KEY_FAVS = (id) => `aerial_favs_${id}`;
const KEY_RECENT = (id) => `aerial_recent_${id}`;
const KEY_CATFAVS = (id) => `aerial_catfavs_${id}`;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable / full — non-fatal */
  }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function newProfileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadProfiles() {
  const list = readJson(KEY_PROFILES, []);
  return Array.isArray(list) ? list.filter((p) => p && p.id && p.type) : [];
}

export function saveProfiles(list) {
  writeJson(KEY_PROFILES, list);
}

export function getProfile(id) {
  return loadProfiles().find((p) => p.id === id) || null;
}

export function upsertProfile(profile) {
  const list = loadProfiles();
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx === -1) list.push(profile);
  else list[idx] = profile;
  saveProfiles(list);
  return profile;
}

export function deleteProfile(id) {
  const list = loadProfiles().filter((p) => p.id !== id);
  saveProfiles(list);
  removeKey(KEY_SECRET(id));
  removeKey(KEY_FAVS(id));
  removeKey(KEY_CATFAVS(id));
  removeKey(KEY_RECENT(id));
  if (getActiveProfileId() === id) setActiveProfileId(list.length ? list[0].id : null);
}

export function getActiveProfileId() {
  const v = readJson(KEY_ACTIVE, null);
  return typeof v === 'string' ? v : null;
}

export function setActiveProfileId(id) {
  if (id === null) removeKey(KEY_ACTIVE);
  else writeJson(KEY_ACTIVE, id);
}

// ---- secrets (opt-in persistence) -------------------------------------------

export function getRememberedSecret(id) {
  const v = readJson(KEY_SECRET(id), null);
  return typeof v === 'string' ? v : null;
}

export function setRememberedSecret(id, secret) {
  if (secret === null || secret === undefined || secret === '') removeKey(KEY_SECRET(id));
  else writeJson(KEY_SECRET(id), String(secret));
}

// ---- per-profile favorites ---------------------------------------------------

export function getFavorites(profileId) {
  const list = readJson(KEY_FAVS(profileId), []);
  return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

export function saveFavorites(profileId, set) {
  writeJson(KEY_FAVS(profileId), [...set]);
}

// ---- per-profile category favorites (pinned categories, separate store) ----

export function getCategoryFavorites(profileId) {
  const list = readJson(KEY_CATFAVS(profileId), []);
  return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

export function saveCategoryFavorites(profileId, set) {
  // Sets iterate in insertion order — the array (and thus the pinned
  // section's ordering) stays stable across reloads.
  writeJson(KEY_CATFAVS(profileId), [...set]);
}

// ---- per-profile recently watched --------------------------------------------

const RECENT_MAX = 20;

export function getRecent(profileId) {
  const list = readJson(KEY_RECENT(profileId), []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string') : [];
}

export function pushRecent(profileId, channel) {
  if (!channel || typeof channel.id !== 'string') return;
  const list = getRecent(profileId).filter((c) => c.id !== channel.id);
  list.unshift({ id: channel.id, name: channel.name || '', logo: channel.logo || '', at: Date.now() });
  writeJson(KEY_RECENT(profileId), list.slice(0, RECENT_MAX));
}
