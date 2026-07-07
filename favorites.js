/**
 * favorites.js
 * Per-user persistent favorites stored in a JSON file.
 * On Vercel (read-only FS except /tmp) we use /tmp/favorites.json.
 * Locally it uses the project root favorites.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vercel has read-only FS except /tmp; detect by checking write access to cwd
const DATA_DIR = (() => {
  try {
    const testPath = path.join(__dirname, '.write_test');
    fs.writeFileSync(testPath, 'x');
    fs.unlinkSync(testPath);
    return __dirname; // local dev — write next to source
  } catch (_) {
    return '/tmp'; // Vercel serverless
  }
})();

const FAVORITES_PATH = path.join(DATA_DIR, 'favorites.json');
const MAX_PER_USER = 50;

function loadAll() {
  try {
    if (fs.existsSync(FAVORITES_PATH)) {
      return JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveAll(data) {
  try {
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('favorites: write error', err.message);
  }
}

/**
 * Get all saved items for a user.
 * @param {number|string} userId
 * @returns {Array<{title, url, videoUrl, siteName, savedAt}>}
 */
export function getFavorites(userId) {
  const all = loadAll();
  return all[String(userId)] || [];
}

/**
 * Save a video to a user's favorites.
 * @returns {boolean} true if newly saved, false if already exists
 */
export function saveFavorite(userId, item) {
  const all = loadAll();
  const uid = String(userId);
  if (!all[uid]) all[uid] = [];

  // Deduplicate by URL
  const exists = all[uid].some(f => f.url === item.url);
  if (exists) return false;

  // Trim to MAX_PER_USER
  if (all[uid].length >= MAX_PER_USER) {
    all[uid].shift(); // remove oldest
  }

  all[uid].push({ ...item, savedAt: new Date().toISOString() });
  saveAll(all);
  return true;
}

/**
 * Remove a saved item by URL.
 * @returns {boolean} true if removed
 */
export function removeFavorite(userId, url) {
  const all = loadAll();
  const uid = String(userId);
  if (!all[uid]) return false;

  const before = all[uid].length;
  all[uid] = all[uid].filter(f => f.url !== url);
  if (all[uid].length === before) return false;

  saveAll(all);
  return true;
}

/**
 * Clear all favorites for a user.
 */
export function clearFavorites(userId) {
  const all = loadAll();
  delete all[String(userId)];
  saveAll(all);
}
