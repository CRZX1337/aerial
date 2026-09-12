import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage shim — profiles.js reads it lazily at call time,
// so installing it before the first call is enough (node --test runs each
// file in its own process, no cross-file interference).
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

const store = await import('../public/js/profiles.js');

test('category favorites persist with stable order', () => {
  store.saveCategoryFavorites('p1', new Set(['sky', '4k', 'sport']));
  assert.deepEqual([...store.getCategoryFavorites('p1')], ['sky', '4k', 'sport']);

  // survives a "reload" (fresh read from the same storage)
  assert.deepEqual([...store.getCategoryFavorites('p1')], ['sky', '4k', 'sport']);
});

test('category favorites are separate from channel favorites', () => {
  store.saveCategoryFavorites('p1', new Set(['sky', '4k', 'sport']));
  store.saveFavorites('p1', new Set(['chan9']));

  assert.deepEqual([...store.getCategoryFavorites('p1')], ['sky', '4k', 'sport']);
  assert.deepEqual([...store.getFavorites('p1')], ['chan9']);

  // mutating one never touches the other
  store.saveCategoryFavorites('p1', new Set(['sky']));
  assert.deepEqual([...store.getFavorites('p1')], ['chan9']);
  assert.deepEqual([...store.getCategoryFavorites('p1')], ['sky']);
});

test('category favorites are namespaced per profile', () => {
  store.saveCategoryFavorites('a', new Set(['news']));
  store.saveCategoryFavorites('b', new Set(['sports']));

  assert.equal(store.getCategoryFavorites('a').has('sports'), false);
  assert.equal(store.getCategoryFavorites('b').has('news'), false);
  assert.deepEqual([...store.getCategoryFavorites('a')], ['news']);
});

test('category favorites tolerate garbage and non-strings in storage', () => {
  storage.set('aerial_catfavs_g1', 'not json');
  assert.deepEqual([...store.getCategoryFavorites('g1')], []);

  storage.set('aerial_catfavs_g2', '[1, null, "ok", {"x":1}]');
  assert.deepEqual([...store.getCategoryFavorites('g2')], ['ok']);
});

test('deleting a profile clears its category favorites', () => {
  store.saveCategoryFavorites('d1', new Set(['x']));
  store.saveFavorites('d1', new Set(['y']));
  store.deleteProfile('d1');
  assert.deepEqual([...store.getCategoryFavorites('d1')], []);
  assert.deepEqual([...store.getFavorites('d1')], []);
});

// ------------------------------------------------------------- settings -----

test('settings: defaults, persistence and key isolation', () => {
  assert.equal(store.getSetting('nameMode', 'auto'), 'auto', 'unset key returns fallback');

  store.setSetting('nameMode', 'two');
  assert.equal(store.getSetting('nameMode', 'auto'), 'two', 'value survives a fresh read');

  // other keys are untouched by one setting
  store.setSetting('other', 1);
  assert.equal(store.getSetting('nameMode', 'x'), 'two');
  assert.equal(store.getSetting('other', 0), 1);

  // overwrite works
  store.setSetting('nameMode', 'full');
  assert.equal(store.getSetting('nameMode', 'auto'), 'full');
});

test('settings: invalid values fall back, garbage storage tolerated', () => {
  storage.set('aerial_settings', 'not json');
  assert.equal(store.getSetting('nameMode', 'auto'), 'auto');

  // writing over garbage recovers cleanly
  store.setSetting('nameMode', 'one');
  assert.equal(store.getSetting('nameMode', 'auto'), 'one');

  storage.set('aerial_settings', '[1,2]');
  assert.equal(store.getSetting('nameMode', 'auto'), 'auto', 'non-object storage reads as unset');

  storage.set('aerial_settings', '{"nameMode":42}');
  assert.equal(store.getSetting('nameMode', 'auto'), 42, 'values are returned as stored (validation lives in the UI layer)');
});

test('settings are device-level and do not interfere with profile data', () => {
  store.setSetting('nameMode', 'two');
  store.saveCategoryFavorites('s1', new Set(['cat']));
  store.saveFavorites('s1', new Set(['chan']));
  assert.deepEqual([...store.getCategoryFavorites('s1')], ['cat']);
  assert.deepEqual([...store.getFavorites('s1')], ['chan']);
  assert.equal(store.getSetting('nameMode', 'auto'), 'two');
});
