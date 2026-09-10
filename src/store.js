import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Small JSON file store. Keeps the Aerial app-account password hashes
 * (never plaintext) across restarts.
 *
 * IPTV provider credentials are NOT stored here: in the player model the
 * browser talks to the user's own provider directly and the server never
 * sees provider credentials at all.
 */

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadAuth() {
  return readJson(AUTH_FILE, { admin: null, user: null });
}

export function saveAuth(auth) {
  writeJsonAtomic(AUTH_FILE, auth);
}
