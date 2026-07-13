/**
 * kv-storage.js
 * Unified storage using Vercel Blob (JSON persistence) + Edge Config (simple flags).
 * Works on Vercel (Blob + Edge Config) and locally (JSON files).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_VERCEL = process.env.VERCEL === '1';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const EDGE_CONFIG = process.env.EDGE_CONFIG; // Edge Config connection string

// Local file fallback
const LOCAL_DATA_DIR = (() => {
  try {
    const testPath = path.join(__dirname, '.write_test');
    fs.writeFileSync(testPath, 'x');
    fs.unlinkSync(testPath);
    return __dirname;
  } catch (_) {
    return '/tmp';
  }
})();

const FAVORITES_FILE = path.join(LOCAL_DATA_DIR, 'favorites.json');
const SCHEDULED_USERS_FILE = path.join(LOCAL_DATA_DIR, 'scheduled_users.json');

// ─── Blob helpers ────────────────────────────────────────────────────────────

async function blobGet(pathname) {
  if (!IS_VERCEL || !BLOB_TOKEN) return null;
  try {
    const res = await fetch(`https://blob.vercel-storage.com${pathname}`, {
      headers: { 'Authorization': `Bearer ${BLOB_TOKEN}` }
    });
    if (!res.ok) return null;
    return res.json();
  } catch (_) {
    return null;
  }
}

async function blobPut(pathname, data) {
  if (!IS_VERCEL || !BLOB_TOKEN) return false;
  try {
    const res = await fetch(`https://blob.vercel-storage.com${pathname}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${BLOB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ─── Edge Config helpers ─────────────────────────────────────────────────────

async function edgeGet(key) {
  if (!IS_VERCEL || !EDGE_CONFIG) return undefined;
  try {
    // Edge Config SDK is not available in serverless without @vercel/edge-config
    // Use REST API instead
    const res = await fetch(`${EDGE_CONFIG}/items/${key}`, {
      headers: { 'Authorization': `Bearer ${process.env.EDGE_CONFIG_TOKEN || ''}` }
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.value;
  } catch (_) {
    return undefined;
  }
}

async function edgeSet(key, value) {
  if (!IS_VERCEL || !EDGE_CONFIG) return false;
  try {
    const res = await fetch(`${EDGE_CONFIG}/items/${key}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.EDGE_CONFIG_TOKEN || ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value })
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ─── Generic read/write with fallback chain ─────────────────────────────────

async function readJsonBlobOrLocal(blobPath, localFile) {
  // Try Blob first
  const blobData = await blobGet(blobPath);
  if (blobData !== null) return blobData;
  
  // Fallback to local file
  try {
    if (fs.existsSync(localFile)) {
      return JSON.parse(fs.readFileSync(localFile, 'utf8'));
    }
  } catch (_) {}
  return null;
}

async function writeJsonBlobAndLocal(blobPath, localFile, data) {
  let ok = false;
  if (IS_VERCEL && BLOB_TOKEN) {
    ok = await blobPut(blobPath, data);
  }
  // Always write local as backup (works in dev, ignored in prod)
  try {
    fs.writeFileSync(localFile, JSON.stringify(data, null, 2));
    ok = true;
  } catch (_) {}
  return ok;
}

// ─── Favorites ────────────────────────────────────────────────────────────────

export async function getFavorites(userId) {
  const all = await readJsonBlobOrLocal('/favorites.json', FAVORITES_FILE) || {};
  return all[String(userId)] || [];
}

export async function saveFavorite(userId, item) {
  const all = await readJsonBlobOrLocal('/favorites.json', FAVORITES_FILE) || {};
  const uid = String(userId);
  if (!all[uid]) all[uid] = [];
  if (all[uid].some(f => f.url === item.url)) return false;
  if (all[uid].length >= 50) all[uid].shift();
  all[uid].push({ ...item, savedAt: new Date().toISOString() });
  await writeJsonBlobAndLocal('/favorites.json', FAVORITES_FILE, all);
  return true;
}

export async function removeFavorite(userId, url) {
  const all = await readJsonBlobOrLocal('/favorites.json', FAVORITES_FILE) || {};
  const uid = String(userId);
  if (!all[uid]) return false;
  const before = all[uid].length;
  all[uid] = all[uid].filter(f => f.url !== url);
  if (all[uid].length === before) return false;
  await writeJsonBlobAndLocal('/favorites.json', FAVORITES_FILE, all);
  return true;
}

export async function clearFavorites(userId) {
  const all = await readJsonBlobOrLocal('/favorites.json', FAVORITES_FILE) || {};
  delete all[String(userId)];
  await writeJsonBlobAndLocal('/favorites.json', FAVORITES_FILE, all);
}

// ─── Scheduled Users (auto-send opt-in) ──────────────────────────────────────

export async function getScheduledUsers() {
  return await readJsonBlobOrLocal('/scheduled_users.json', SCHEDULED_USERS_FILE) || [];
}

export async function addScheduledUser(userId, chatId, options = {}) {
  const users = await getScheduledUsers();
  if (users.find(u => u.userId === String(userId))) return false;
  const allSites = ['desiporn', 'mmsbee', 'desipapa', 'hotpic', 'viralmms', 'desisexvdo', 'desibabe', 'desihub', 'desibf', 'desileak49', 'mastiraja'];
  users.push({
    userId: String(userId),
    chatId: String(chatId),
    time: options.time || '09:00',
    timezone: options.timezone || 'Asia/Kolkata',
    enabled: true,
    sites: options.sites || allSites,
    groupTopics: options.groupTopics || false,
    forceChannel: options.forceChannel || null,
    addedAt: new Date().toISOString()
  });
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return true;
}

export async function removeScheduledUser(userId) {
  let users = await getScheduledUsers();
  const before = users.length;
  users = users.filter(u => u.userId !== String(userId));
  if (users.length === before) return false;
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return true;
}

export async function toggleScheduledUser(userId) {
  let users = await getScheduledUsers();
  const user = users.find(u => u.userId === String(userId));
  if (!user) return null;
  user.enabled = !user.enabled;
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return user.enabled;
}

export async function updateScheduledUserSites(userId, sites) {
  let users = await getScheduledUsers();
  const user = users.find(u => u.userId === String(userId));
  if (!user) return false;
  user.sites = sites;
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return true;
}

export async function getScheduledUser(userId) {
  const users = await getScheduledUsers();
  return users.find(u => u.userId === String(userId));
}

export async function updateScheduledUserGroupTopics(userId, enabled) {
  let users = await getScheduledUsers();
  const user = users.find(u => u.userId === String(userId));
  if (!user) return false;
  user.groupTopics = enabled;
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return true;
}

export async function updateScheduledUserForceChannel(userId, forceChannel) {
  let users = await getScheduledUsers();
  const user = users.find(u => u.userId === String(userId));
  if (!user) return false;
  user.forceChannel = forceChannel;
  await writeJsonBlobAndLocal('/scheduled_users.json', SCHEDULED_USERS_FILE, users);
  return true;
}

// ─── Admin & Force Channel ──────────────────────────────────────────────────
const ADMIN_FILE = path.join(LOCAL_DATA_DIR, 'admins.json');
const FORCE_CHANNEL_FILE = path.join(LOCAL_DATA_DIR, 'force_channel.json');

async function readAdminBlobOrLocal() {
  const blobData = await blobGet('/admins.json');
  if (blobData !== null) return blobData;
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    }
  } catch (_) {}
  return { admins: [], firstUser: null };
}

async function writeAdminBlobAndLocal(data) {
  let ok = false;
  if (IS_VERCEL && BLOB_TOKEN) {
    ok = await blobPut('/admins.json', data);
  }
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2));
    ok = true;
  } catch (_) {}
  return ok;
}

async function readForceChannelBlobOrLocal() {
  const blobData = await blobGet('/force_channel.json');
  if (blobData !== null) return blobData;
  try {
    if (fs.existsSync(FORCE_CHANNEL_FILE)) {
      return JSON.parse(fs.readFileSync(FORCE_CHANNEL_FILE, 'utf8'));
    }
  } catch (_) {}
  return { channelId: null, channelUsername: null };
}

async function writeForceChannelBlobAndLocal(data) {
  let ok = false;
  if (IS_VERCEL && BLOB_TOKEN) {
    ok = await blobPut('/force_channel.json', data);
  }
  try {
    fs.writeFileSync(FORCE_CHANNEL_FILE, JSON.stringify(data, null, 2));
    ok = true;
  } catch (_) {}
  return ok;
}

export async function isAdmin(userId) {
  const data = await readAdminBlobOrLocal();
  return data.admins.includes(String(userId)) || data.firstUser === String(userId);
}

export async function getAdmins() {
  const data = await readAdminBlobOrLocal();
  return data.admins;
}

export async function addAdmin(userId) {
  const data = await readAdminBlobOrLocal();
  const uid = String(userId);
  if (!data.firstUser) data.firstUser = uid;
  if (!data.admins.includes(uid)) data.admins.push(uid);
  await writeAdminBlobAndLocal(data);
  return true;
}

export async function removeAdmin(userId) {
  const data = await readAdminBlobOrLocal();
  data.admins = data.admins.filter(u => u !== String(userId));
  await writeAdminBlobAndLocal(data);
  return true;
}

export async function getForceChannel() {
  return await readForceChannelBlobOrLocal();
}

export async function setForceChannel(channelId, channelUsername) {
  await writeForceChannelBlobAndLocal({ channelId, channelUsername });
  return true;
}

export async function removeForceChannel() {
  await writeForceChannelBlobAndLocal({ channelId: null, channelUsername: null });
  return true;
}

export async function checkForceSubscribe(bot, userId) {
  const fc = await getForceChannel();
  if (!fc.channelId) return true;
  try {
    const member = await bot.telegram.getChatMember(fc.channelId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (_) {
    return false;
  }
}
