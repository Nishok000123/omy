import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  scrapeDesiPorn,
  scrapeMMSBee,
  scrapeDesiPapa,
  scrapeHotpic,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja,
  scrapeLatestDesiMms,
  scrapeMmsGram,
  scrapeIndianPorn365,
  getRequestHeaders,
  ensureClearance
} from './scraper.js';
import { getFavorites, saveFavorite, removeFavorite, clearFavorites, addScheduledUser, removeScheduledUser, toggleScheduledUser, getScheduledUser, updateScheduledUserSites, updateScheduledUserGroupTopics, updateScheduledUserForceChannel, isAdmin, addAdmin, removeAdmin, getForceChannel, setForceChannel, removeForceChannel, checkForceSubscribe, getAdmins, updateScheduledUserGroups, upsertScheduledUserTopic } from './kv-storage.js';

// Admin system + force channel globals (must be declared before initializeBotState)
const adminUsers = new Set();
let forceChannel = null;

// ---------------------------------------------------------------------------
// Initialize bot state from storage (admins, force channel)
// ---------------------------------------------------------------------------
async function initializeBotState() {
  // Load admins from storage
  const storedAdmins = await getAdmins();
  storedAdmins.forEach(uid => adminUsers.add(String(uid)));
  
  // Add hardcoded admin
  const HARDCODED_ADMIN = '5688847060';
  if (!adminUsers.has(HARDCODED_ADMIN)) {
    adminUsers.add(HARDCODED_ADMIN);
    await addAdmin(HARDCODED_ADMIN);
    console.log(`✅ Added hardcoded admin: ${HARDCODED_ADMIN}`);
  }
  
  // Load force channel from storage
  const fc = await getForceChannel();
  if (fc && fc.channelUsername) {
    forceChannel = fc.channelUsername;
    console.log(`✅ Loaded force channel: @${forceChannel}`);
  }
  
  console.log(`✅ Initialized: ${adminUsers.size} admin(s), force channel: ${forceChannel || 'none'}`);
}

// ---------------------------------------------------------------------------
// downloadVideo – streams a remote video to a temp file using the same
// rotating-UA + Referer + Cloudflare-clearance headers as the scrapers.
// Throws if the file is > 45 MB or the server returns a non-200 status.
// ---------------------------------------------------------------------------
async function downloadVideo(videoUrl, siteBaseUrl) {
  const baseUrl = siteBaseUrl || new URL(videoUrl).origin;
  await ensureClearance(baseUrl);
  const headers = getRequestHeaders(baseUrl);

  const response = await axios({
    method: 'get',
    url: videoUrl,
    responseType: 'stream',
    headers,
    timeout: 60000,  // 60 s for large files
    maxRedirects: 5,
    validateStatus: null
  });

  if (response.status !== 200) {
    throw new Error(`Download failed – HTTP ${response.status}`);
  }

  // Respect Content-Length if present
  const contentLength = Number(response.headers['content-length'] || 0);
  const maxBytes = 45 * 1024 * 1024; // 45 MB safety margin
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Video too large (${(contentLength / (1024 * 1024)).toFixed(1)} MB > 45 MB limit)`);
  }

  const tmpPath = path.join(os.tmpdir(), `tgvid_${Date.now()}.mp4`);
  const writer = fs.createWriteStream(tmpPath);
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    response.data.on('data', chunk => {
      downloaded += chunk.length;
      if (downloaded > maxBytes) {
        writer.destroy();
        reject(new Error('Video exceeded 45 MB size limit during streaming'));
      }
    });
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return tmpPath; // caller must delete after use
}

dotenv.config();

if (!process.env.BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is missing in the env configuration.');
  process.exit(1);
}

// Resilient bot initialization with retry for Vercel network issues
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      const isNetworkError = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.errno === 'ECONNRESET';
      if (!isNetworkError && !err.message?.includes('ECONNRESET')) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

let bot;
async function initBot() {
  if (bot) return bot;
  try {
    bot = new Telegraf(process.env.BOT_TOKEN);
    // Monkey-patch getMe to avoid init crash on Vercel
    bot.telegram.getMe = async () => ({ id: 0, username: 'bot', first_name: 'Bot' });
    return bot;
  } catch (err) {
    console.error('Bot init error:', err.message);
    throw err;
  }
}

await initBot();

// Initialize bot state from storage
await initializeBotState();

// Global error handler to prevent bot from crashing
bot.catch((err, ctx) => {
  console.error(`Telegraf caught an error for update ${ctx.update?.update_id}:`, err);
});

const TAG_LABELS = {
  tamil: 'Tamil',
  mallu: 'Mallu',
  south_indian: 'South Indian',
  young: 'Young'
};

const HELP_TEXT = `📖 *Usage*:\n\n` +
  `1. Pick a *source* to open filters / pages.\n` +
  `2. Use quick *tags* on the main menu.\n` +
  `3. Type any word to search across sources.\n` +
  `4. Type a #hashtag for tag search.\n` +
  `5. 💾 *Save* bookmarks items; /favorites lists them.\n` +
  `6. Toggle *Auto-Delete* for timed media cleanup.\n` +
  `7. *Auto-Send* for digests + forum topic routing.\n\n` +
  `Use /start for the main menu.`;

// In-memory store for chat settings (default to 15 minutes auto-delete)
const chatSettings = {};

// Map to store custom query IDs to avoid exceeding Telegram's 64-byte callback query data limit
const customQueries = {};
let queryCounter = 0;
let customQueriesSize = 0;

// Map to store video URLs for download to bypass 64-byte limit
const videoDownloadUrls = new Map();
let videoIdCounter = 0;

// Helper to store video URL and get short ID
function getShortVideoId(url) {
  if (!url) return null;
  videoIdCounter++;
  const id = `v${videoIdCounter}`;
  videoDownloadUrls.set(id, url);

  // Prune map if too large
  if (videoDownloadUrls.size > 10000) {
    let count = 0;
    for (const key of videoDownloadUrls.keys()) {
      if (count >= 2000) break;
      videoDownloadUrls.delete(key);
      count++;
    }
  }
  return id;
}

// Force subscribe middleware
async function forceSubscribeMiddleware(ctx, next) {
  if (!forceChannel) return next();
  
  const userId = ctx.from?.id;
  if (!userId) return next();
  
  // Skip for admins (IDs stored as strings)
  if (adminUsers.has(String(userId))) return next();
  
  // Skip for certain commands
  if (ctx.message?.text?.startsWith('/start')) return next();
  
  try {
    const isMember = await checkForceSubscribe(bot, userId);
    if (!isMember) {
      await ctx.replyWithMarkdown(
        `🔒 *Force Subscribe Required*\n\n` +
        `You must join our channel to use this bot:\n` +
        `[@${forceChannel}](https://t.me/${forceChannel})\n\n` +
        `After joining, press /start again.`,
        Markup.inlineKeyboard([
          [Markup.button.url('📢 Join Channel', `https://t.me/${forceChannel}`)],
          [Markup.button.callback('✅ I Joined', 'check_force_subscribe')]
        ])
      ).catch(() => {});
      return;
    }
  } catch (e) {
    console.error('Force subscribe check failed:', e.message);
  }
  
  return next();
}

bot.use(forceSubscribeMiddleware);

// Helper to schedule message deletion
function scheduleDeletion(ctx, messageIds, minutes) {
  if (!minutes || minutes <= 0) return;
  setTimeout(async () => {
    await Promise.allSettled(
      messageIds.map((msgId) => ctx.telegram.deleteMessage(ctx.chat.id, msgId))
    );
  }, minutes * 60 * 1000);
}

// Helper to merge and shuffle results from multiple scrapers
function mergeResults(resultsArray) {
  return [].concat(...resultsArray).filter(Boolean).sort(() => Math.random() - 0.5);
}

// Consolidated AIO Scraper (shuffles/combines posts from all sites)
async function scrapeAIO(page = 1, filterType = 'latest') {
  const limitPerSite = 2;
  const results = await Promise.all([
    scrapeDesiPorn(page, '', limitPerSite).catch(() => []),
    scrapeMMSBee(page, '', limitPerSite).catch(() => []),
    scrapeDesiPapa(page, '', limitPerSite).catch(() => []),
    scrapeHotpic(page, limitPerSite).catch(() => []),
    scrapeViralMms(page, limitPerSite).catch(() => []),
    scrapeDesiSexVdo(page, '', limitPerSite).catch(() => []),
    scrapeDesiBabe(page, limitPerSite).catch(() => []),
    scrapeDesiHub(page, limitPerSite).catch(() => []),
    scrapeDesiBF(page, '', limitPerSite).catch(() => []),
    scrapeDesiLeak49(page, '', limitPerSite).catch(() => []),
    scrapeMastiRaja(page, '', limitPerSite).catch(() => []),
    scrapeLatestDesiMms(page, filterType === 'popular' ? 'most-viewed' : 'latest', limitPerSite).catch(() => []),
    scrapeIndianPorn365(page, filterType === 'popular' ? 'most-viewed' : 'latest', limitPerSite).catch(() => []),
    scrapeMmsGram(page, 'latest-trending', limitPerSite).catch(() => [])
  ]);

  const mergedPosts = mergeResults(results);
  return mergedPosts.slice(0, 10);
}

// Consolidated AIO Tag/Text Search Scraper (combines search results from the searchable sites)
async function searchAllSites(page = 1, query = '') {
  const limitPerSite = 2;
  const results = await Promise.all([
    scrapeDesiPorn(page, query, limitPerSite).catch(() => []),
    scrapeMMSBee(page, query, limitPerSite).catch(() => []),
    scrapeDesiPapa(page, query, limitPerSite).catch(() => []),
    scrapeHotpic(page, limitPerSite).catch(() => []),
    scrapeDesiSexVdo(page, query, limitPerSite).catch(() => []),
    scrapeDesiBF(page, query, limitPerSite).catch(() => []),
    scrapeDesiLeak49(page, query, limitPerSite).catch(() => []),
    scrapeMastiRaja(page, query, limitPerSite).catch(() => []),
    scrapeLatestDesiMms(page, query, limitPerSite).catch(() => []),
    scrapeIndianPorn365(page, query, limitPerSite).catch(() => [])
  ]);

  const mergedPosts = mergeResults(results);
  return mergedPosts.slice(0, 10);
}

const ALL_SITE_KEYS = [
  'desiporn', 'mmsbee', 'desipapa', 'hotpic', 'viralmms', 'desisexvdo',
  'desibabe', 'desihub', 'desibf', 'desileak49', 'mastiraja',
  'latestdesimms', 'mmsgram', 'indianporn365'
];

const ALL_SITES_UI = [
  { key: 'desiporn', label: 'DesiPorn 🔥' },
  { key: 'mmsbee', label: 'MMSBee 🐝' },
  { key: 'desipapa', label: 'DesiPapa 🎬' },
  { key: 'hotpic', label: 'Hotpic 🔥' },
  { key: 'viralmms', label: 'ViralMMS 🎬' },
  { key: 'desisexvdo', label: 'DesiSexVdo 🎥' },
  { key: 'desibabe', label: 'DesiBabe 🍑' },
  { key: 'desihub', label: 'DesiHub 🇮🇳' },
  { key: 'desibf', label: 'DesiBF 💋' },
  { key: 'desileak49', label: 'DesiLeak49 💦' },
  { key: 'mastiraja', label: 'MastiRaja 🍿' },
  { key: 'latestdesimms', label: 'LatestDesiMMS 📹' },
  { key: 'mmsgram', label: 'MMSGram 💬' },
  { key: 'indianporn365', label: 'IndianPorn365 🇮🇳' }
];

// Generate the main menu dynamically based on chat settings
function getMainMenu(chatId) {
  const settings = chatSettings[chatId] || { autoDeleteMinutes: 15 };
  let deleteLabel = '⏳ Auto-Delete: Off';
  if (settings.autoDeleteMinutes === 15) deleteLabel = '⏳ Auto-Delete: 15 Min';
  else if (settings.autoDeleteMinutes === 30) deleteLabel = '⏳ Auto-Delete: 30 Min';

  return Markup.inlineKeyboard([
    // Row 1: Unified All-in-One consolidated feeds
    [
      Markup.button.callback('🔥 Trending (All-in-One)', 'scrape_trending_all_in_one_1'),
      Markup.button.callback('🌟 Popular (All-in-One)', 'scrape_popular_all_in_one_1')
    ],
    // Individual Sites
    [Markup.button.callback('DesiPorn 🔥', 'site_desiporn'), Markup.button.callback('MMSBee 🐝', 'site_mmsbee')],
    [Markup.button.callback('DesiPapa 🎬', 'site_desipapa'), Markup.button.callback('Hotpic 🔥', 'site_hotpic')],
    [Markup.button.callback('ViralMMS 🎬', 'site_viralmms'), Markup.button.callback('DesiSexVdo 🎥', 'site_desisexvdo')],
    [Markup.button.callback('DesiBabe 🍑', 'site_desibabe'), Markup.button.callback('DesiHub 🇮🇳', 'site_desihub')],
    [Markup.button.callback('DesiBF 💋', 'site_desibf'), Markup.button.callback('DesiLeak49 💦', 'site_desileak49')],
    [Markup.button.callback('MastiRaja 🍿', 'site_mastiraja'), Markup.button.callback('LatestDesiMMS 📹', 'site_latestdesimms')],
    [Markup.button.callback('MMSGram 💬', 'site_mmsgram'), Markup.button.callback('IndianPorn365 🇮🇳', 'site_indianporn365')],
    // Predefined Tags
    [Markup.button.callback('Tamil 🇮🇳', 'tag_tamil'), Markup.button.callback('Mallu 🥥', 'tag_mallu')],
    [Markup.button.callback('South Indian 🌴', 'tag_south_indian'), Markup.button.callback('Young 👧', 'tag_young')],
    // Auto-Send & Settings
    [Markup.button.callback('⚙️ Auto-Send / Daily', 'auto_send_menu'), Markup.button.callback(deleteLabel, 'toggle_autodelete')],
    [Markup.button.callback('❓ Help & Usage', 'help')]
  ]);
}

// Sends the page selection menu
async function sendPageSelector(ctx, siteName, siteKey) {
  const text = `📄 *Select Page for ${siteName}*:\n\nChoose which page number you want to scrape from *${siteName}*.`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('1', `scrape_${siteKey}_1`),
      Markup.button.callback('2', `scrape_${siteKey}_2`),
      Markup.button.callback('3', `scrape_${siteKey}_3`),
      Markup.button.callback('4', `scrape_${siteKey}_4`),
      Markup.button.callback('5', `scrape_${siteKey}_5`)
    ],
    [
      Markup.button.callback('6', `scrape_${siteKey}_6`),
      Markup.button.callback('7', `scrape_${siteKey}_7`),
      Markup.button.callback('8', `scrape_${siteKey}_8`),
      Markup.button.callback('9', `scrape_${siteKey}_9`),
      Markup.button.callback('10', `scrape_${siteKey}_10`)
    ],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  }).catch(() => {});
}

/** WP-tube filter options (LatestDesiMMS / IndianPorn365) */
async function sendFilterSelector(ctx, siteName, siteKey) {
  const text = `🎛️ *${siteName} — pick filter*\n\nEach site has own listing options:`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🆕 Latest', `opt_${siteKey}_latest`),
      Markup.button.callback('👁 Most Viewed', `opt_${siteKey}_most-viewed`)
    ],
    [
      Markup.button.callback('⭐ Popular', `opt_${siteKey}_popular`),
      Markup.button.callback('⏱ Longest', `opt_${siteKey}_longest`)
    ],
    [Markup.button.callback('🎲 Random', `opt_${siteKey}_random`)],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
}

/** MMSGram forum options */
async function sendMmsGramOptions(ctx) {
  const text = `💬 *MMSGram — pick forum*\n\nLatest trending / desi new videos:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Latest Trending', 'opt_mmsgram_latest-trending')],
    [Markup.button.callback('🆕 Desi New Videos HD/SD', 'opt_mmsgram_desi-new')],
    [Markup.button.callback('⭐ Exclusive Trending', 'opt_mmsgram_exclusive')],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
}

// Builds inline keyboard controls for pagination under the last post of a batch
function getPaginationKeyboard(siteKey, page, tag = '', queryId = '', videoUrl = null) {
  let cleanSiteKey = siteKey.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
  let prefix = `scrape_${cleanSiteKey}`;
  
  if (queryId) {
    prefix = `csearch_${cleanSiteKey}_${queryId}`;
  } else if (tag) {
    const tagKey = Object.keys(TAG_LABELS).find(k => TAG_LABELS[k].toLowerCase() === tag.toLowerCase()) || tag.toLowerCase().replace(/\s+/g, '_');
    prefix = `search_${cleanSiteKey}_${tagKey}`;
  }
  
  const buttons = [];

  if (videoUrl) {
    const shortId = getShortVideoId(videoUrl);
    buttons.push([
      Markup.button.url('🎥 Watch Direct Video', videoUrl),
      Markup.button.callback('⬇️ Download to Telegram', `dl_${shortId}`)
    ]);
    buttons.push([
      Markup.button.callback('🎬 Video Preview', `vn_${shortId}`)
    ]);
  }

  // Navigation row
  const navRow = [];
  if (page > 1) {
    navRow.push(Markup.button.callback(`⬅️ Page ${page - 1}`, `${prefix}_${page - 1}`));
  }
  navRow.push(Markup.button.callback(`Page ${page}`, 'noop'));
  navRow.push(Markup.button.callback(`Page ${page + 1} ➡️`, `${prefix}_${page + 1}`));
  buttons.push(navRow);

  // Jump buttons row
  const startPage = Math.max(1, page - 2);
  const jumpRow = [];
  for (let i = startPage; i <= startPage + 4; i++) {
    jumpRow.push(Markup.button.callback(`${i === page ? '• ' + i + ' •' : i}`, `${prefix}_${i}`));
  }
  buttons.push(jumpRow);

  // Back row
  const backLabel = '🔙 Main Menu';
  const backCallback = 'back_to_main';
  buttons.push([Markup.button.callback(backLabel, backCallback)]);

  return Markup.inlineKeyboard(buttons);
}

bot.start((ctx) => {
  const welcomeText = `👋 *Welcome to Omy Feed Bot!*\n\n` +
    `Pick a source, use a quick tag, or **type a search word** to pull digests from your feeds.`;
  ctx.replyWithMarkdown(welcomeText, getMainMenu(ctx.chat.id)).catch(() => {});
});

bot.help((ctx) => {
  ctx.replyWithMarkdown(HELP_TEXT, getMainMenu(ctx.chat.id)).catch(() => {});
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...getMainMenu(ctx.chat.id)
  }).catch(() => {});
});

bot.action('back_to_main', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const welcomeText = `👋 *Welcome to Omy Feed Bot!*\n\n` +
    `Pick a source, use a quick tag, or **type a search word** to pull digests from your feeds.`;
  
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    const msg = ctx.callbackQuery.message;
    // Handle different message types that can't be edited
    if (msg.photo || msg.video || msg.video_note || msg.animation || msg.document) {
      try {
        await ctx.editMessageReplyMarkup(null);
      } catch (e) {}
      await ctx.replyWithMarkdown(welcomeText, getMainMenu(ctx.chat.id)).catch(() => {});
    } else {
      await ctx.editMessageText(welcomeText, {
        parse_mode: 'Markdown',
        ...getMainMenu(ctx.chat.id)
      }).catch(() => {});
    }
  }
});

// Auto-Delete toggle handler
bot.action('toggle_autodelete', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const settings = chatSettings[chatId] || { autoDeleteMinutes: 15 };

  if (settings.autoDeleteMinutes === 15) {
    settings.autoDeleteMinutes = 30;
  } else if (settings.autoDeleteMinutes === 30) {
    settings.autoDeleteMinutes = 0; // Off
  } else {
    settings.autoDeleteMinutes = 15;
  }
  chatSettings[chatId] = settings;

  const welcomeText = `👋 *Welcome to Omy Feed Bot!*\n\n` +
    `Pick a source, use a quick tag, or **type a search word** to pull digests from your feeds.`;

  await ctx.editMessageText(welcomeText, {
    parse_mode: 'Markdown',
    ...getMainMenu(chatId)
  }).catch(() => {});
});

// ─── Auto-Send Menu ─────────────────────────────────────────────────────────────
bot.action('auto_send_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const user = await getScheduledUser(userId);
  
  const isEnabled = user?.enabled || false;
  const siteCount = user?.sites?.length || ALL_SITE_KEYS.length;
  const groupTopics = user?.groupTopics || false;
  const forceChannelUser = user?.forceChannel || null;
  const fcDisplay = forceChannelUser || forceChannel || null;

  const text = `⚙️ *Auto-Send / Daily Digest Settings*\n\n` +
    `📬 Daily Digest: ${isEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
    `🌐 Sites Selected: ${siteCount === ALL_SITE_KEYS.length ? `All (${ALL_SITE_KEYS.length})` : `${siteCount}/${ALL_SITE_KEYS.length}`}\n` +
    `📍 Group Topics: ${groupTopics ? '✅ Enabled (tag→topic)' : '❌ Disabled'}\n` +
    `🔒 Force Channel: ${fcDisplay ? `@${fcDisplay}` : 'None'}\n\n` +
    `Group topics: Tamil topic gets Tamil content.\n` +
    `Use /setgroup in group + /settopic Name inside topic.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Daily' : '🟢 Enable Daily', 'toggle_daily')],
    [Markup.button.callback('🌐 Select Sites', 'setting_sites')],
    [Markup.button.callback(groupTopics ? '📍 Disable Group Topics' : '📍 Enable Group Topics', 'toggle_group_topics')],
    [Markup.button.callback('🔒 Set Force Channel', 'set_force_channel')],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  }).catch(() => {});
});

bot.action('toggle_daily', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const enabled = await toggleScheduledUser(userId);
  
  if (enabled === null) {
    const added = await addScheduledUser(userId, chatId);
    if (added) {
      await ctx.answerCbQuery('✅ Daily digest enabled!').catch(() => {});
    }
  } else {
    await ctx.answerCbQuery(enabled ? '✅ Enabled' : '❌ Disabled').catch(() => {});
  }
  
  // Refresh menu
  const user = await getScheduledUser(userId);
  const isEnabled = user?.enabled || false;
  const siteCount = user?.sites?.length || ALL_SITE_KEYS.length;
  const groupTopics = user?.groupTopics || false;
  const forceChannelUser = user?.forceChannel || null;
  const fcDisplay = forceChannelUser || forceChannel || null;

  const text = `⚙️ *Auto-Send / Daily Digest Settings*\n\n` +
    `📬 Daily Digest: ${isEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
    `🌐 Sites Selected: ${siteCount === ALL_SITE_KEYS.length ? `All (${ALL_SITE_KEYS.length})` : `${siteCount}/${ALL_SITE_KEYS.length}`}\n` +
    `📍 Group Topics: ${groupTopics ? '✅ Enabled (tag→topic)' : '❌ Disabled'}\n` +
    `🔒 Force Channel: ${fcDisplay ? `@${fcDisplay}` : 'None'}\n\n` +
    `Group topics: Tamil topic gets Tamil content.\n` +
    `Use /setgroup in group + /settopic Name inside topic.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Daily' : '🟢 Enable Daily', 'toggle_daily')],
    [Markup.button.callback('🌐 Select Sites', 'setting_sites')],
    [Markup.button.callback(groupTopics ? '📍 Disable Group Topics' : '📍 Enable Group Topics', 'toggle_group_topics')],
    [Markup.button.callback('🔒 Set Force Channel', 'set_force_channel')],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  }).catch(() => {});
});

bot.action('setting_sites', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getScheduledUser(userId);
  const userSites = user?.sites || [...ALL_SITE_KEYS];

  const keyboard = Markup.inlineKeyboard([
    ...ALL_SITES_UI.map(site => [
      Markup.button.callback(
        `${userSites.includes(site.key) ? '✅' : '⬜'} ${site.label}`,
        `setting_site_${site.key}`
      )
    ]),
    [Markup.button.callback('🔙 Back to Auto-Send', 'auto_send_menu')]
  ]);

  await ctx.editMessageText(
    `🌐 *Select Sites for Daily Digest*\n\n` +
    `Click to toggle each site. Selected: ${userSites.length}/${ALL_SITE_KEYS.length}`,
    { parse_mode: 'Markdown', ...keyboard }
  ).catch(() => {});
});

bot.action(/^setting_site_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const siteKey = ctx.match[1];
  const user = await getScheduledUser(userId);
  const userSites = user?.sites || [...ALL_SITE_KEYS];
  
  const idx = userSites.indexOf(siteKey);
  if (idx >= 0) {
    userSites.splice(idx, 1);
  } else {
    userSites.push(siteKey);
  }
  
  await updateScheduledUserSites(userId, userSites);

  const keyboard = Markup.inlineKeyboard([
    ...ALL_SITES_UI.map(site => [
      Markup.button.callback(
        `${userSites.includes(site.key) ? '✅' : '⬜'} ${site.label}`,
        `setting_site_${site.key}`
      )
    ]),
    [Markup.button.callback('🔙 Back to Auto-Send', 'auto_send_menu')]
  ]);

  await ctx.editMessageReplyMarkup(keyboard.reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Toggled ${siteKey}`).catch(() => {});
});

bot.action('toggle_group_topics', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getScheduledUser(userId);
  const newValue = !(user?.groupTopics || false);
  
  // auto-create scheduled user if missing so non-admins can use topics
  if (!user) {
    await addScheduledUser(userId, ctx.chat.id, { groupTopics: newValue });
  } else {
    await updateScheduledUserGroupTopics(userId, newValue);
  }
  
  // Refresh menu
  const updatedUser = await getScheduledUser(userId);
  const isEnabled = updatedUser?.enabled || false;
  const siteCount = updatedUser?.sites?.length || ALL_SITE_KEYS.length;
  const groupTopics = updatedUser?.groupTopics || false;
  const forceChannelUser = updatedUser?.forceChannel || null;
  const fcDisplay = forceChannelUser || forceChannel || null;

  const text = `⚙️ *Auto-Send / Daily Digest Settings*\n\n` +
    `📬 Daily Digest: ${isEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
    `🌐 Sites Selected: ${siteCount === ALL_SITE_KEYS.length ? `All (${ALL_SITE_KEYS.length})` : `${siteCount}/${ALL_SITE_KEYS.length}`}\n` +
    `📍 Group Topics: ${groupTopics ? '✅ Enabled (tag→topic)' : '❌ Disabled'}\n` +
    `🔒 Force Channel: ${fcDisplay ? `@${fcDisplay}` : 'None'}\n\n` +
    `Tamil topic ← Tamil tag content. Use /setgroup + /settopic.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Daily' : '🟢 Enable Daily', 'toggle_daily')],
    [Markup.button.callback('🌐 Select Sites', 'setting_sites')],
    [Markup.button.callback(groupTopics ? '📍 Disable Group Topics' : '📍 Enable Group Topics', 'toggle_group_topics')],
    [Markup.button.callback('🔒 Set Force Channel', 'set_force_channel')],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  }).catch(() => {});
  
  await ctx.answerCbQuery(`Group topics ${newValue ? 'enabled' : 'disabled'}`).catch(() => {});
});

bot.action('set_force_channel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '🔒 *Set Force Channel*\n\n' +
    'Send:\n`/forcechannel @yourchannel`\n\n' +
    'Anyone can set. Admin bare `/forcechannel` removes it.',
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// Setup site triggers to load page selectors
bot.action('site_desiporn', (ctx) => sendPageSelector(ctx, 'DesiPorn', 'desiporn'));
bot.action('site_mmsbee', (ctx) => sendPageSelector(ctx, 'MMSBee', 'mmsbee'));
bot.action('site_desipapa', (ctx) => sendPageSelector(ctx, 'DesiPapa', 'desipapa'));
bot.action('site_hotpic', (ctx) => sendPageSelector(ctx, 'Hotpic', 'hotpic'));
bot.action('site_viralmms', (ctx) => sendPageSelector(ctx, 'ViralMMS', 'viralmms'));
bot.action('site_desisexvdo', (ctx) => sendPageSelector(ctx, 'DesiSexVdo', 'desisexvdo'));
bot.action('site_desibabe', (ctx) => sendPageSelector(ctx, 'DesiBabe', 'desibabe'));
bot.action('site_desihub', (ctx) => sendPageSelector(ctx, 'DesiHub', 'desihub'));
bot.action('site_desibf', (ctx) => sendPageSelector(ctx, 'DesiBF', 'desibf'));
bot.action('site_desileak49', (ctx) => sendPageSelector(ctx, 'DesiLeak49', 'desileak49'));
bot.action('site_mastiraja', (ctx) => sendPageSelector(ctx, 'MastiRaja', 'mastiraja'));
bot.action('site_latestdesimms', (ctx) => sendFilterSelector(ctx, 'LatestDesiMMS', 'latestdesimms'));
bot.action('site_indianporn365', (ctx) => sendFilterSelector(ctx, 'IndianPorn365', 'indianporn365'));
bot.action('site_mmsgram', (ctx) => sendMmsGramOptions(ctx));

// Filter/forum option → page selector (siteKey becomes site_filter)
bot.action(/^opt_(latestdesimms|indianporn365)_(latest|most-viewed|popular|longest|random)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const site = ctx.match[1];
  const filter = ctx.match[2];
  const label = site === 'latestdesimms' ? 'LatestDesiMMS' : 'IndianPorn365';
  await sendPageSelector(ctx, `${label} (${filter})`, `${site}_${filter}`);
});

bot.action(/^opt_mmsgram_(latest-trending|desi-new|exclusive)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const forum = ctx.match[1];
  await sendPageSelector(ctx, `MMSGram (${forum})`, `mmsgram_${forum}`);
});

bot.action(/^tag_(.+)$/, async (ctx) => {
  const tagKey = ctx.match[1];
  const tagLabel = TAG_LABELS[tagKey] || tagKey;
  await ctx.answerCbQuery().catch(() => {});

  const text = `🔍 *Search Tag: ${tagLabel}*\n\nSelect which site you want to search for *"${tagLabel}"*:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Combined Search (All Sites)', `search_all_${tagKey}_1`)],
    [
      Markup.button.callback('DesiPorn 🔥', `search_desiporn_${tagKey}_1`),
      Markup.button.callback('MMSBee 🐝', `search_mmsbee_${tagKey}_1`)
    ],
    [
      Markup.button.callback('DesiPapa 🎬', `search_desipapa_${tagKey}_1`),
      Markup.button.callback('Hotpic 🔥', `search_hotpic_${tagKey}_1`)
    ],
    [
      Markup.button.callback('DesiSexVdo 🎥', `search_desisexvdo_${tagKey}_1`),
      Markup.button.callback('DesiBF 💋', `search_desibf_${tagKey}_1`)
    ],
    [
      Markup.button.callback('DesiLeak49 💦', `search_desileak49_${tagKey}_1`),
      Markup.button.callback('MastiRaja 🍿', `search_mastiraja_${tagKey}_1`)
    ],
    [
      Markup.button.callback('LatestDesiMMS 📹', `search_latestdesimms_${tagKey}_1`),
      Markup.button.callback('IndianPorn365 🇮🇳', `search_indianporn365_${tagKey}_1`)
    ],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.photo) {
    try {
      await ctx.editMessageReplyMarkup(null);
    } catch (e) {}
    await ctx.replyWithMarkdown(text, keyboard).catch(() => {});
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard
    }).catch(() => {});
  }
});

// Handle text search queries from the user
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  const text = ctx.message.text.trim();
  if (!text) return;

  // ── Hashtag / free-form tag search (#tamil, #mallu, #bhabhi etc.) ───────
  if (text.startsWith('#')) {
    const tag = text.slice(1).trim().toLowerCase().replace(/\s+/g, '_');
    if (!tag) return;

    const tagLabel = TAG_LABELS[tag] || text.slice(1).trim(); // Use display label if predefined

    // Check if it's a predefined tag key first
    const tagKey = TAG_LABELS[tag] ? tag : tag.replace(/\s+/g, '_');

    const responseText = `🏷️ *Tag search: "${tagLabel}"*\n\nSelect which site to search on:`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Combined Search (All Sites)', `search_all_${tagKey}_1`)],
      [
        Markup.button.callback('DesiPorn 🔥', `search_desiporn_${tagKey}_1`),
        Markup.button.callback('MMSBee 🐝', `search_mmsbee_${tagKey}_1`)
      ],
      [
        Markup.button.callback('DesiPapa 🎬', `search_desipapa_${tagKey}_1`),
        Markup.button.callback('Hotpic 🔥', `search_hotpic_${tagKey}_1`)
      ],
      [
        Markup.button.callback('DesiSexVdo 🎥', `search_desisexvdo_${tagKey}_1`),
        Markup.button.callback('DesiBF 💋', `search_desibf_${tagKey}_1`)
      ],
      [
        Markup.button.callback('DesiLeak49 💦', `search_desileak49_${tagKey}_1`),
        Markup.button.callback('MastiRaja 🍿', `search_mastiraja_${tagKey}_1`)
      ],
      [
        Markup.button.callback('LatestDesiMMS 📹', `search_latestdesimms_${tagKey}_1`),
        Markup.button.callback('IndianPorn365 🇮🇳', `search_indianporn365_${tagKey}_1`)
      ],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
    ]);

    await ctx.replyWithMarkdown(responseText, keyboard).catch(() => {});
    return;
  }

  queryCounter++;
  const queryId = `q${queryCounter}`;
  customQueries[queryId] = text;
  customQueriesSize++;

  // Prune map if too large
  if (customQueriesSize > 5000) {
    const keys = Object.keys(customQueries);
    for (let i = 0; i < 1000; i++) {
      if (keys[i] && customQueries[keys[i]]) {
        delete customQueries[keys[i]];
        customQueriesSize--;
      }
    }
  }

  const responseText = `🔍 *Search results for: "${text}"*\n\nSelect which site you want to search on:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Combined Search (All Sites)', `csearch_all_${queryId}_1`)],
    [
      Markup.button.callback('DesiPorn 🔥', `csearch_desiporn_${queryId}_1`),
      Markup.button.callback('MMSBee 🐝', `csearch_mmsbee_${queryId}_1`)
    ],
    [
      Markup.button.callback('DesiPapa 🎬', `csearch_desipapa_${queryId}_1`),
      Markup.button.callback('Hotpic 🔥', `csearch_hotpic_${queryId}_1`)
    ],
    [
      Markup.button.callback('DesiSexVdo 🎥', `csearch_desisexvdo_${queryId}_1`),
      Markup.button.callback('DesiBF 💋', `csearch_desibf_${queryId}_1`)
    ],
    [
      Markup.button.callback('DesiLeak49 💦', `csearch_desileak49_${queryId}_1`),
      Markup.button.callback('MastiRaja 🍿', `csearch_mastiraja_${queryId}_1`)
    ],
    [
      Markup.button.callback('LatestDesiMMS 📹', `csearch_latestdesimms_${queryId}_1`),
      Markup.button.callback('IndianPorn365 🇮🇳', `csearch_indianporn365_${queryId}_1`)
    ],
    [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
  ]);

  await ctx.replyWithMarkdown(responseText, keyboard).catch(() => {});
});

// Handle page scrape action
async function handleScrapeAction(ctx, siteName, page, scrapeFn, tag = '', queryId = '') {
  const actionLabel = tag ? `Search "${tag}" (Page ${page})` : `Page ${page}`;
  await ctx.answerCbQuery(`Scraping ${actionLabel} of ${siteName}...`).catch(() => {});
  
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageReplyMarkup(null);
    } catch (e) {}
  }
  
  const statusMsg = await ctx.replyWithMarkdown(`🔍 _Fetching ${actionLabel.toLowerCase()} from *${siteName}*..._`).catch(() => {});

  try {
    console.log(`[Scrape] ${siteName} page ${page}${tag ? ' tag=' + tag : ''} start`);
    const posts = tag ? await scrapeFn(page, tag) : await scrapeFn(page);
    console.log(`[Scrape] ${siteName} returned ${posts?.length || 0} posts`);
    
    if (!posts || posts.length === 0) {
      if (statusMsg) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
        } catch (e) {}
      }
      
      const failText = tag 
        ? `❌ No posts found for *"${tag}"* on *Page ${page}* of *${siteName}*.`
        : `❌ No posts found on *Page ${page}* of *${siteName}*.`;

      const failKeyboard = getMainMenu(ctx.chat.id);

      await ctx.replyWithMarkdown(failText, failKeyboard).catch(() => {});
      return;
    }

    if (statusMsg) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }

    const sentMessageIds = [];

    // Process each post/album
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      
      // Check if it's a Hotpic album with multiple videos
      if (post._isAlbum && post._albumVideos && post._albumVideos.length > 1) {
        // Send as media group (album)
        try {
          const media = post._albumVideos.map((video, idx) => ({
            type: 'video',
            media: video.videoUrl,
            caption: idx === 0 ? 
              `🔥 *${i + 1}. ${post.title}*\n\n` +
              `🌐 *Source*: ${post.siteName || siteName}\n` +
              `📄 *Page*: ${page}\n` +
              (tag ? `🏷️ *Tag/Search*: ${tag}\n` : '') +
              `🔗 [Original Album](${post.url})\n\n` +
              `📦 *Album: ${post._albumVideos.length} videos*`
              : undefined,
            parse_mode: 'Markdown'
          }));

          const msgs = await ctx.replyWithMediaGroup(media);
          sentMessageIds.push(...msgs.map(m => m.message_id));
          
          // Send pagination keyboard on last album
          if (i === posts.length - 1) {
            const keyboard = Markup.inlineKeyboard([
              [
                Markup.button.url('🎥 Watch Direct Video', post._albumVideos[0].videoUrl),
                Markup.button.callback('⬇️ Download First', `dl_${getShortVideoId(post._albumVideos[0].videoUrl)}`)
              ],
              [
                Markup.button.callback('📥 Download All', `dl_all_${getShortVideoId(post.url)}`)
              ],
              [
                Markup.button.callback('🎬 Video Preview', `vn_${getShortVideoId(post._albumVideos[0].videoUrl)}`)
              ]
            ]);
            const msg = await ctx.replyWithMarkdown(
              `📦 *Album: ${post.title}* (${post._albumVideos.length} videos)\n\nUse buttons below:`,
              keyboard
            ).catch(() => {});
            if (msg) sentMessageIds.push(msg.message_id);
          }
        } catch (albumErr) {
          console.error('Album send failed, falling back to individual:', albumErr.message);
          // Fallback: send first video individually
          await sendSinglePost(ctx, post, post._albumVideos[0], i, page, tag, siteName, sentMessageIds, i === posts.length - 1, queryId);
        }
      } else {
        // Regular single video post
        const videoData = post._albumVideos?.[0] || post;
        await sendSinglePost(ctx, post, videoData, i, page, tag, siteName, sentMessageIds, i === posts.length - 1, queryId);
      }
    }

    // Schedule deletion if enabled
    const settings = chatSettings[ctx.chat.id] || { autoDeleteMinutes: 15 };
    if (settings.autoDeleteMinutes > 0) {
      scheduleDeletion(ctx, sentMessageIds, settings.autoDeleteMinutes);
      const selfDestructMsg = await ctx.replyWithMarkdown(
        `⏳ _These messages will auto-delete in *${settings.autoDeleteMinutes} minutes*_`
      ).catch(() => {});
      if (selfDestructMsg) {
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, selfDestructMsg.message_id);
          } catch (e) {}
        }, settings.autoDeleteMinutes * 60 * 1000);
      }
    }

  } catch (err) {
    console.error(`Error scraping ${siteName} Page ${page}:`, err);
    if (statusMsg) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }
    await ctx.replyWithMarkdown(
      `❌ *Error scraping ${siteName}*\n_${err.message}_`,
      getMainMenu(ctx.chat.id)
    ).catch(() => {});
  }
}

// Helper: send a single video post (used for regular posts + album fallback)
async function sendSinglePost(ctx, post, videoData, index, page, tag, siteName, sentMessageIds, isLast, queryId = '') {
  const caption = `🔥 *${index + 1}. ${videoData.title}*\n\n` +
    `🌐 *Source*: ${post.siteName || siteName}\n` +
    `📄 *Page*: ${page}\n` +
    (tag ? `🏷️ *Tag/Search*: ${tag}\n` : '') +
    `🔗 [Original Post](${post.url})\n\n` +
    `📥 *Direct Video URL* (tap to copy):\n` +
    `\`${videoData.videoUrl}\``;

  let keyboard = null;
  if (videoData.videoUrl) {
    const shortId = getShortVideoId(videoData.videoUrl);
    const saveId = getShortVideoId(post.url || videoData.videoUrl);
    videoDownloadUrls.set(`save_${saveId}`, JSON.stringify({ 
      title: videoData.title, 
      url: post.url, 
      videoUrl: videoData.videoUrl, 
      siteName: post.siteName || siteName 
    }));
    keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url('🎥 Watch Direct Video', videoData.videoUrl),
        Markup.button.callback('⬇️ Download to Telegram', `dl_${shortId}`)
      ],
      [
        Markup.button.callback('💾 Save', `save_${saveId}`)
      ],
      [
        Markup.button.callback('🎬 Video Preview', `vn_${shortId}`)
      ]
    ]);
  }

  const replyOptions = {
    caption,
    parse_mode: 'Markdown',
    ...(keyboard ? keyboard : {})
  };

  try {
    let msg = null;
    // Try native video first with fallback logic
    try {
      if (videoData.videoUrl) {
        // For Hotpic, try direct URL but catch and fallback to download
        if (post.siteName === 'Hotpic' || videoData.videoUrl.includes('hotpic.cc')) {
          try {
            msg = await ctx.replyWithVideo(videoData.videoUrl, replyOptions);
          } catch (hotpicErr) {
            // Fallback: download and re-upload
            console.log('Hotpic direct URL failed, downloading...', hotpicErr.message);
            const tmpPath = await downloadVideo(videoData.videoUrl, post.siteBaseUrl || 'https://hotpic.cc');
            msg = await ctx.replyWithVideo({ source: fs.createReadStream(tmpPath) }, replyOptions);
            try { fs.unlinkSync(tmpPath); } catch (_) {}
          }
        } else {
          msg = await ctx.replyWithVideo(videoData.videoUrl, replyOptions);
        }
      } else {
        throw new Error("No video url");
      }
    } catch (videoErr) {
      if (videoData.thumbnail) {
        msg = await ctx.replyWithPhoto(videoData.thumbnail, replyOptions).catch(() => {});
      } else {
        if (keyboard) {
          msg = await ctx.replyWithMarkdown(caption, keyboard).catch(() => {});
        } else {
          msg = await ctx.replyWithMarkdown(caption).catch(() => {});
        }
      }
    }
    if (msg) sentMessageIds.push(msg.message_id);
  } catch (err) {
    let msg;
    if (keyboard) {
      msg = await ctx.replyWithMarkdown(caption, keyboard).catch(() => {});
    } else {
      msg = await ctx.replyWithMarkdown(caption).catch(() => {});
    }
    if (msg) sentMessageIds.push(msg.message_id);
  }

  // If this is the last post and not an album, add pagination
  if (isLast && !post._isAlbum) {
    const paginationKeyboard = getPaginationKeyboard(siteName.toLowerCase(), page, tag, queryId, videoData.videoUrl);
    try {
      let msgLast = null;
      try {
        if (videoData.videoUrl) {
          msgLast = await ctx.replyWithVideo(videoData.videoUrl, {
            caption,
            parse_mode: 'Markdown',
            ...paginationKeyboard
          });
        } else {
          throw new Error("No video url");
        }
      } catch (videoErr) {
        if (videoData.thumbnail) {
          msgLast = await ctx.replyWithPhoto(videoData.thumbnail, {
            caption,
            parse_mode: 'Markdown',
            ...paginationKeyboard
          }).catch(() => {});
        } else {
          msgLast = await ctx.replyWithMarkdown(caption, paginationKeyboard).catch(() => {});
        }
      }
      if (msgLast) sentMessageIds.push(msgLast.message_id);
    } catch (err) {
      const msgLast = await ctx.replyWithMarkdown(caption, paginationKeyboard).catch(() => {});
      if (msgLast) sentMessageIds.push(msgLast.message_id);
    }
  }
}

function resolveScrapeTarget(siteKey) {
  // compound keys: latestdesimms_most-viewed | mmsgram_desi-new
  if (siteKey.startsWith('latestdesimms_')) {
    const filter = siteKey.slice('latestdesimms_'.length);
    return {
      siteName: `LatestDesiMMS (${filter})`,
      scrapeFn: (p) => scrapeLatestDesiMms(p, filter)
    };
  }
  if (siteKey.startsWith('indianporn365_')) {
    const filter = siteKey.slice('indianporn365_'.length);
    return {
      siteName: `IndianPorn365 (${filter})`,
      scrapeFn: (p) => scrapeIndianPorn365(p, filter)
    };
  }
  if (siteKey.startsWith('mmsgram_')) {
    const forum = siteKey.slice('mmsgram_'.length);
    return {
      siteName: `MMSGram (${forum})`,
      scrapeFn: (p) => scrapeMmsGram(p, forum)
    };
  }

  const map = {
    trending_all_in_one: { siteName: 'Trending (All-in-One)', scrapeFn: (p) => scrapeAIO(p, 'trending') },
    popular_all_in_one: { siteName: 'Popular (All-in-One)', scrapeFn: (p) => scrapeAIO(p, 'popular') },
    desiporn: { siteName: 'DesiPorn', scrapeFn: scrapeDesiPorn },
    viralmms: { siteName: 'ViralMMS', scrapeFn: scrapeViralMms },
    desisexvdo: { siteName: 'DesiSexVdo', scrapeFn: scrapeDesiSexVdo },
    desibabe: { siteName: 'DesiBabe', scrapeFn: scrapeDesiBabe },
    desihub: { siteName: 'DesiHub', scrapeFn: scrapeDesiHub },
    desibf: { siteName: 'DesiBF', scrapeFn: scrapeDesiBF },
    desileak49: { siteName: 'DesiLeak49', scrapeFn: scrapeDesiLeak49 },
    mmsbee: { siteName: 'MMSBee', scrapeFn: scrapeMMSBee },
    desipapa: { siteName: 'DesiPapa', scrapeFn: scrapeDesiPapa },
    hotpic: { siteName: 'Hotpic', scrapeFn: scrapeHotpic },
    mastiraja: { siteName: 'MastiRaja', scrapeFn: scrapeMastiRaja },
    latestdesimms: { siteName: 'LatestDesiMMS', scrapeFn: (p) => scrapeLatestDesiMms(p, 'most-viewed') },
    indianporn365: { siteName: 'IndianPorn365', scrapeFn: (p) => scrapeIndianPorn365(p, 'latest') },
    mmsgram: { siteName: 'MMSGram', scrapeFn: (p) => scrapeMmsGram(p, 'latest-trending') },
    all: { siteName: 'All Sites', scrapeFn: searchAllSites }
  };
  return map[siteKey] || null;
}

// Register generic page scraper action handler (allow hyphens in site/filter keys)
bot.action(/^scrape_([a-z0-9_-]+)_(\d+)$/, async (ctx) => {
  const siteKey = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  const target = resolveScrapeTarget(siteKey);

  if (target) {
    await handleScrapeAction(ctx, target.siteName, page, target.scrapeFn);
  } else {
    await ctx.answerCbQuery('Invalid site selection.').catch(() => {});
  }
});

const validSitesPattern = 'all|desiporn|mmsbee|desipapa|hotpic|viralmms|desisexvdo|desibabe|desihub|desibf|desileak49|mastiraja|latestdesimms|mmsgram|indianporn365|trending_all_in_one|popular_all_in_one';

// Register generic tag search handler
bot.action(new RegExp('^search_(' + validSitesPattern + ')_(.+)_(\\d+)$'), async (ctx) => {
  const siteKey = ctx.match[1];
  const tagKey = ctx.match[2];
  const page = parseInt(ctx.match[3], 10);
  const tagLabel = TAG_LABELS[tagKey] || tagKey.replace(/_/g, ' ');

  let siteName = '';
  let scrapeFn = null;

  if (siteKey === 'all') {
    siteName = 'All Sites';
    scrapeFn = searchAllSites;
  } else if (siteKey === 'latestdesimms') {
    siteName = 'LatestDesiMMS';
    scrapeFn = (p, q) => scrapeLatestDesiMms(p, q);
  } else if (siteKey === 'indianporn365') {
    siteName = 'IndianPorn365';
    scrapeFn = (p, q) => scrapeIndianPorn365(p, q);
  } else {
    const target = resolveScrapeTarget(siteKey);
    if (target && siteKey !== 'trending_all_in_one' && siteKey !== 'popular_all_in_one') {
      siteName = target.siteName;
      scrapeFn = target.scrapeFn;
    }
  }

  if (scrapeFn) {
    await handleScrapeAction(ctx, siteName, page, scrapeFn, tagLabel);
  } else {
    await ctx.answerCbQuery('Invalid site or tag selection.').catch(() => {});
  }
});

// Register custom search callback query triggers
bot.action(new RegExp('^csearch_(' + validSitesPattern + ')_(.+)_(\\d+)$'), async (ctx) => {
  const siteKey = ctx.match[1];
  const queryId = ctx.match[2];
  const page = parseInt(ctx.match[3], 10);

  const queryText = customQueries[queryId];
  if (!queryText) {
    await ctx.answerCbQuery('⚠️ Search query expired. Please type a new search word.', { show_alert: true }).catch(() => {});
    return;
  }

  let siteName = '';
  let scrapeFn = null;

  if (siteKey === 'all') {
    siteName = 'All Sites';
    scrapeFn = searchAllSites;
  } else if (siteKey === 'latestdesimms') {
    siteName = 'LatestDesiMMS';
    scrapeFn = (p, q) => scrapeLatestDesiMms(p, q);
  } else if (siteKey === 'indianporn365') {
    siteName = 'IndianPorn365';
    scrapeFn = (p, q) => scrapeIndianPorn365(p, q);
  } else {
    const target = resolveScrapeTarget(siteKey);
    if (target) {
      siteName = target.siteName;
      scrapeFn = target.scrapeFn;
    }
  }

  if (scrapeFn) {
    await handleScrapeAction(ctx, siteName, page, scrapeFn, queryText, queryId);
  } else {
    await ctx.answerCbQuery('Invalid site selection.').catch(() => {});
  }
});

// ─── Download handler ─────────────────────────────────────────────────────────
bot.action(/^dl_(v\d+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const videoUrl = videoDownloadUrls.get(shortId);

  if (!videoUrl) {
    return ctx.answerCbQuery('⚠️ Download link expired. Please search again.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('⬇️ Downloading... this may take a minute.').catch(() => {});
  const statusMsg = await ctx.replyWithMarkdown('⏳ _Downloading video to Telegram..._').catch(() => {});

  let tmpPath = null;
  try {
    let siteBaseUrl;
    try { siteBaseUrl = new URL(videoUrl).origin; } catch (_) { siteBaseUrl = ''; }

    tmpPath = await downloadVideo(videoUrl, siteBaseUrl);

    await ctx.replyWithVideo(
      { source: fs.createReadStream(tmpPath) },
      { caption: '✅ *Video Downloaded Successfully*', parse_mode: 'Markdown' }
    );

    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  } catch (error) {
    console.error('Error downloading video:', error.message);
    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    await ctx.replyWithMarkdown(
      `❌ *Could not download the video.*\n_Reason: ${error.message}_\n\n📥 Direct link:\n\`${videoUrl}\``
    ).catch(() => {});
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
});

// ─── Video Note preview handler ──────────────────────────────────────────────
bot.action(/^vn_(v\d+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const videoUrl = videoDownloadUrls.get(shortId);

  if (!videoUrl) {
    return ctx.answerCbQuery('⚠️ Preview link expired. Please search again.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('🎬 Loading preview...').catch(() => {});
  const statusMsg = await ctx.replyWithMarkdown('⏳ _Loading video preview..._').catch(() => {});

  let tmpPath = null;
  try {
    let siteBaseUrl;
    try { siteBaseUrl = new URL(videoUrl).origin; } catch (_) { siteBaseUrl = ''; }

    tmpPath = await downloadVideo(videoUrl, siteBaseUrl);

    await ctx.telegram.sendVideoNote(ctx.chat.id, { source: fs.createReadStream(tmpPath) });

    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  } catch (error) {
    console.error('Error sending video note:', error.message);
    if (statusMsg) {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ *Could not load preview.*\n_Reason: ${error.message}_`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}
    }
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

// ─── Force subscribe check handler ─────────────────────────────────────────────
bot.action('check_force_subscribe', async (ctx) => {
  await ctx.answerCbQuery('🔄 Checking...').catch(() => {});
  
  const userId = ctx.from.id;
  try {
    const isMember = await checkForceSubscribe(bot, userId);
    if (isMember) {
      await ctx.deleteMessage().catch(() => {});
      // Re-trigger start
      const welcomeText = `👋 *Welcome to Omy Feed Bot!*\n\n` +
        `Pick a source, use a quick tag, or **type a search word** to pull digests from your feeds.`;
      await ctx.replyWithMarkdown(welcomeText, getMainMenu(ctx.chat.id)).catch(() => {});
    } else {
      await ctx.answerCbQuery('❌ You have not joined yet. Please join the channel first.', { show_alert: true }).catch(() => {});
    }
  } catch (e) {
    await ctx.answerCbQuery('❌ Could not verify membership. Try again.', { show_alert: true }).catch(() => {});
  }
});

// ─── Admin commands ────────────────────────────────────────────────────────────
function isBotAdmin(userId) {
  return adminUsers.has(String(userId));
}

bot.command('adduser', async (ctx) => {
  const userId = ctx.from.id;
  if (!isBotAdmin(userId)) return ctx.reply('❌ Admin only.').catch(() => {});
  
  const text = ctx.message.text.split(' ')[1];
  if (!text) return ctx.reply('Usage: /adduser @username or /adduser user_id').catch(() => {});
  
  const targetId = text.startsWith('@') ? text.slice(1) : text;
  await addAdmin(targetId);
  await ctx.reply(`✅ Added ${targetId} as admin`).catch(() => {});
});

bot.command('removeuser', async (ctx) => {
  const userId = ctx.from.id;
  if (!isBotAdmin(userId)) return ctx.reply('❌ Admin only.').catch(() => {});
  
  const text = ctx.message.text.split(' ')[1];
  if (!text) return ctx.reply('Usage: /removeuser @username or /removeuser user_id').catch(() => {});
  
  const targetId = text.startsWith('@') ? text.slice(1) : text;
  await removeAdmin(targetId);
  await ctx.reply(`✅ Removed ${targetId} from admins`).catch(() => {});
});

// Any user can set force channel (global). Admin required only to remove.
bot.command('forcechannel', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.split(' ')[1];

  if (!text) {
    if (!isBotAdmin(userId)) {
      return ctx.reply('Usage: /forcechannel @channelusername\n(Only admin can remove with bare /forcechannel)').catch(() => {});
    }
    await removeForceChannel();
    forceChannel = null;
    return ctx.reply('✅ Force channel removed').catch(() => {});
  }

  const channelUsername = text.startsWith('@') ? text.slice(1) : text;
  try {
    const chatInfo = await bot.telegram.getChat(`@${channelUsername}`);
    await setForceChannel(chatInfo.id, channelUsername);
    forceChannel = channelUsername;
    // also store on scheduled user if present
    await updateScheduledUserForceChannel(userId, channelUsername).catch(() => {});
    await ctx.reply(`✅ Force channel set to @${channelUsername} (ID: ${chatInfo.id})`).catch(() => {});
  } catch (e) {
    await ctx.reply(`❌ Could not find channel @${channelUsername}: ${e.message}`).catch(() => {});
  }
});

bot.command('broadcast', async (ctx) => {
  const userId = ctx.from.id;
  if (!isBotAdmin(userId)) return ctx.reply('❌ Admin only.').catch(() => {});
  
  const message = ctx.message.text.slice(10).trim(); // '/broadcast '.length = 10
  if (!message) return ctx.reply('Usage: /broadcast Your message here').catch(() => {});
  
  const users = await getScheduledUsers();
  let sent = 0, failed = 0;
  
  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.chatId, message, { parse_mode: 'Markdown' });
      sent++;
    } catch (_) {
      failed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  await ctx.reply(`📢 Broadcast complete: ${sent} sent, ${failed} failed`).catch(() => {});
});

// ─── /groupinfo command — get group chat ID and forum topics ────────────────────
bot.command('groupinfo', async (ctx) => {
  // Check if used in a group
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command only works in groups/supergroups.').catch(() => {});
  }

  const chatId = ctx.chat.id;
  const chatTitle = ctx.chat.title || 'Unknown';
  const chatType = ctx.chat.type;
  const userId = ctx.from.id;

  let response = `📊 *Group Information*\n\n` +
    `📛 *Name*: ${chatTitle}\n` +
    `🆔 *Chat ID*: \`${chatId}\`\n` +
    `📦 *Type*: ${chatType}\n`;

  // Check if bot is admin
  try {
    const botMember = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
    const isAdmin = ['administrator', 'creator'].includes(botMember.status);
    response += `🔐 *Bot Admin*: ${isAdmin ? '✅ Yes' : '❌ No'}\n`;
    
    if (!isAdmin) {
      response += `\n⚠️ *Bot needs admin rights to send to forum topics*\n`;
    }
  } catch (e) {
    response += `🔐 *Bot Admin*: ❓ Unknown\n`;
  }

  // Try to get forum topics if supergroup
  if (chatType === 'supergroup') {
    try {
      // Telegram's getForumTopicIconStickers is for getting sticker sets
      // We need a different approach - try to get chat info
      const chat = await bot.telegram.getChat(chatId);
      
      if (chat.is_forum) {
        response += `\n📍 *Forum Topics*: ✅ Enabled\n`;
        response += `\nℹ️ Bot will auto-fetch topics when sending.\n`;
        response += `Topics are matched by name:\n`;
        response += `• "Tamil" topic → Tamil content\n`;
        response += `• "Mallu" topic → Mallu content\n`;
        response += `• Case-insensitive matching\n`;
      } else {
        response += `\n📍 *Forum Topics*: ❌ Not a forum group\n`;
      }
    } catch (e) {
      response += `\n⚠️ Could not check forum status: ${e.message}\n`;
    }
  }

  response += `\n\n**Next Steps:**\n`;
  response += `1. Copy the Chat ID above\n`;
  response += `2. Add to your config in \`scheduled_users.json\`:\n`;
  response += `\`\`\`json\n`;
  response += `"groups": [\n`;
  response += `  {\n`;
  response += `    "chatId": "${chatId}",\n`;
  response += `    "topics": []\n`;
  response += `  }\n`;
  response += `]\n`;
  response += `\`\`\`\n`;
  response += `3. Enable "Group Topics" in /settings\n`;
  response += `4. Bot will auto-send to matching topics every 6 hours`;

  await ctx.replyWithMarkdown(response).catch(() => {});
});

// ─── /topicinfo command — get forum topic thread ID ───────────────────────────
bot.command('topicinfo', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message.message_thread_id;
  
  if (!threadId) {
    return ctx.reply(
      '❌ This command only works in forum topic threads.\n\n' +
      '💡 Use it INSIDE a specific topic (like your Tamil topic) to get the thread ID needed for auto-send.'
    ).catch(() => {});
  }
  
  let response = `📍 *Forum Topic Thread Info*\n\n`;
  response += `🆔 *Chat ID*: \`${chatId}\`\n`;
  response += `🧵 *Thread ID*: \`${threadId}\`\n\n`;
  response += `Register with:\n\`/settopic Tamil\` (use topic tag name)\n`;
  response += `Auto-send matches topic name to content tags.`;
  
  await ctx.replyWithMarkdown(response).catch(() => {});
});

// ─── /setgroup — register current group for topic auto-send (any user) ────────
bot.command('setgroup', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ Run /setgroup inside the target group/supergroup.').catch(() => {});
  }
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  let user = await getScheduledUser(userId);
  if (!user) {
    await addScheduledUser(userId, chatId, { groupTopics: true });
    user = await getScheduledUser(userId);
  }
  const groups = user?.groups || [];
  if (!groups.find(g => String(g.chatId) === String(chatId))) {
    groups.push({ chatId: String(chatId), topics: [] });
  }
  await updateScheduledUserGroups(userId, groups);
  await updateScheduledUserGroupTopics(userId, true);
  await ctx.replyWithMarkdown(
    `✅ Group registered for topic auto-send\n` +
    `🆔 Chat ID: \`${chatId}\`\n\n` +
    `Next: go *inside* each forum topic and run:\n` +
    `\`/settopic Tamil\`\n` +
    `\`/settopic Mallu\`\n` +
    `Name must match content tag.`
  ).catch(() => {});
});

// ─── /settopic <Name> — bind current thread to a tag name (any user) ──────────
bot.command('settopic', async (ctx) => {
  const chatId = ctx.chat.id;
  const threadId = ctx.message.message_thread_id;
  const userId = ctx.from.id;

  if (ctx.chat.type === 'private' || !threadId) {
    return ctx.reply(
      '❌ Run /settopic *inside* a forum topic thread.\n' +
      'Example: /settopic Tamil'
    ).catch(() => {});
  }

  const name = (ctx.message.text.split(/\s+/).slice(1).join(' ') || '').trim();
  if (!name) {
    return ctx.reply('Usage: /settopic Tamil\n(topic name = content tag)').catch(() => {});
  }

  await upsertScheduledUserTopic(userId, chatId, {
    name,
    message_thread_id: threadId
  });

  await ctx.replyWithMarkdown(
    `✅ Topic mapped\n` +
    `🏷 *Name/Tag*: ${name}\n` +
    `🧵 *Thread*: \`${threadId}\`\n` +
    `🆔 *Chat*: \`${chatId}\`\n\n` +
    `Auto-send will push *${name}* content into this topic.`
  ).catch(() => {});
});

// ─── Save / Unsave handlers ───────────────────────────────────────────────────
bot.action(/^save_(v\d+)$/, async (ctx) => {
  const saveId = ctx.match[1];
  const rawData = videoDownloadUrls.get(`save_${saveId}`);
  if (!rawData) {
    return ctx.answerCbQuery('❌ Save data expired. Please search again.').catch(() => {});
  }
  try {
    const item = JSON.parse(rawData);
    const added = saveFavorite(ctx.from.id, item);
    if (added) {
      await ctx.answerCbQuery('💾 Saved to your favorites!').catch(() => {});
    } else {
      await ctx.answerCbQuery('⚠️ Already in your favorites.').catch(() => {});
    }
  } catch (err) {
    await ctx.answerCbQuery('❌ Could not save.').catch(() => {});
  }
});

// ─── /favorites command ───────────────────────────────────────────────────────
bot.command('favorites', async (ctx) => {
  const items = getFavorites(ctx.from.id);
  if (items.length === 0) {
    await ctx.replyWithMarkdown('📭 *Your favorites list is empty.*\n\nUse the 💾 Save button under any video to bookmark it!', getMainMenu(ctx.chat.id)).catch(() => {});
    return;
  }

  await ctx.replyWithMarkdown(`💾 *Your Saved Videos (${items.length})*\n\nHere are your bookmarked videos:`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const caption = `💾 *${i + 1}. ${item.title}*\n` +
      `🌐 _${item.siteName || 'Unknown'}_\n` +
      `📅 _Saved: ${new Date(item.savedAt).toLocaleDateString('en-IN')}_\n\n` +
      (item.videoUrl ? `[▶️ Watch Video](${item.videoUrl})` : `[🔗 View Post](${item.url})`);

    const keyboard = Markup.inlineKeyboard([
      item.videoUrl ? [Markup.button.url('🎥 Watch', item.videoUrl)] : [],
      [Markup.button.callback('🗑️ Remove', `unsave_${i}_${ctx.from.id}`)]
    ].filter(r => r.length > 0));

    await ctx.replyWithMarkdown(caption, keyboard).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }

  await ctx.replyWithMarkdown(
    `_Tip: Use /clearfavorites to remove all saved videos._`,
    getMainMenu(ctx.chat.id)
  ).catch(() => {});
});

bot.action(/^unsave_(\d+)_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userId = ctx.match[2];
  if (String(ctx.from.id) !== userId) {
    return ctx.answerCbQuery('❌ Not your favorites.').catch(() => {});
  }
  const items = getFavorites(ctx.from.id);
  const item = items[index];
  if (!item) {
    return ctx.answerCbQuery('❌ Item not found.').catch(() => {});
  }
  removeFavorite(ctx.from.id, item.url);
  await ctx.answerCbQuery('🗑️ Removed from favorites.').catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});

bot.command('clearfavorites', async (ctx) => {
  clearFavorites(ctx.from.id);
  await ctx.replyWithMarkdown('🗑️ *All favorites cleared.*', getMainMenu(ctx.chat.id)).catch(() => {});
});

// ─── /daily command — toggle personalized daily digest ──────────────────────────
bot.command('daily', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  const enabled = await toggleScheduledUser(userId);
  if (enabled === null) {
    // First time - add them
    const added = await addScheduledUser(userId, chatId);
    if (added) {
      await ctx.replyWithMarkdown(
        `☀️ *Daily Digest Enabled!*\n\n` +
        `You'll now receive a personalized Top 10 every day at **9:00 AM IST**.\n\n` +
        `Use /daily again to disable.`,
        getMainMenu(ctx.chat.id)
      ).catch(() => {});
    } else {
      await ctx.replyWithMarkdown(
        `ℹ️ *Already subscribed!*\n\n` +
        `Use /daily to toggle on/off.`,
        getMainMenu(ctx.chat.id)
      ).catch(() => {});
    }
  } else if (enabled) {
    await ctx.replyWithMarkdown(
      `☀️ *Daily Digest Enabled!*\n\n` +
      `You'll receive your Top 10 at 9:00 AM IST daily.\n\n` +
      `Use /daily to disable.`,
      getMainMenu(ctx.chat.id)
    ).catch(() => {});
  } else {
    await ctx.replyWithMarkdown(
      `🌙 *Daily Digest Disabled*\n\n` +
      `You won't receive automatic daily messages.\n\n` +
      `Use /daily to re-enable anytime.`,
      getMainMenu(ctx.chat.id)
    ).catch(() => {});
  }
});

// ─── /settings command — configure daily digest sites ────────────────────────────
bot.command('settings', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getScheduledUser(userId);
  
  if (!user) {
    await ctx.replyWithMarkdown(
      `⚙️ *Daily Digest Settings*\n\n` +
      `You're not subscribed to daily digest yet.\n` +
      `Use /daily to enable it first, then customize sites.`,
      getMainMenu(ctx.chat.id)
    ).catch(() => {});
    return;
  }

  const allSites = [
    { key: 'desiporn', label: 'DesiPorn 🔥' },
    { key: 'mmsbee', label: 'MMSBee 🐝' },
    { key: 'desipapa', label: 'DesiPapa 🎬' },
    { key: 'hotpic', label: 'Hotpic 🔥' },
    { key: 'viralmms', label: 'ViralMMS 🎬' },
    { key: 'desisexvdo', label: 'DesiSexVdo 🎥' },
    { key: 'desibabe', label: 'DesiBabe 🍑' },
    { key: 'desihub', label: 'DesiHub 🇮🇳' },
    { key: 'desibf', label: 'DesiBF 💋' },
    { key: 'desileak49', label: 'DesiLeak49 💦' },
    { key: 'mastiraja', label: 'MastiRaja 🍿' }
  ];

  const userSites = user.sites || [];
  const isAll = userSites.includes('all') || userSites.length === allSites.length;

  const keyboard = Markup.inlineKeyboard([
    ...allSites.map(site => [
      Markup.button.callback(
        `${userSites.includes(site.key) ? '✅' : '⬜'} ${site.label}`,
        `setting_site_${site.key}`
      )
    ]),
    [Markup.button.callback(isAll ? '✅ All Sites' : '⬜ All Sites', 'setting_site_all')],
    [Markup.button.callback('💾 Save & Close', 'setting_save'), Markup.button.callback('🔙 Back', 'back_to_main')]
  ]);

  await ctx.replyWithMarkdown(
    `⚙️ *Daily Digest Site Selection*\n\n` +
    `Choose which sites to include in your daily Top 10:\n\n` +
    `_${isAll ? 'All 11 sites selected' : `${userSites.filter(s => s !== 'all').length} of ${allSites.length} sites selected`}_`,
    keyboard
  ).catch(() => {});
});

// Handle site selection callbacks
bot.action(/^setting_site_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const siteKey = ctx.match[1];
  
  const user = await getScheduledUser(userId);
  if (!user) {
    await ctx.answerCbQuery('Not subscribed. Use /daily first.').catch(() => {});
    return;
  }

  const allSites = ['desiporn', 'mmsbee', 'desipapa', 'hotpic', 'viralmms', 'desisexvdo', 'desibabe', 'desihub', 'desibf', 'desileak49', 'mastiraja'];
  let userSites = user.sites || [];

  if (siteKey === 'all') {
    userSites = userSites.length === allSites.length ? [] : allSites;
  } else {
    if (userSites.includes(siteKey)) {
      userSites = userSites.filter(s => s !== siteKey);
    } else {
      userSites.push(siteKey);
    }
  }

  await updateScheduledUserSites(userId, userSites);

  // Update keyboard
  const userSiteLabels = [
    { key: 'desiporn', label: 'DesiPorn 🔥' },
    { key: 'mmsbee', label: 'MMSBee 🐝' },
    { key: 'desipapa', label: 'DesiPapa 🎬' },
    { key: 'hotpic', label: 'Hotpic 🔥' },
    { key: 'viralmms', label: 'ViralMMS 🎬' },
    { key: 'desisexvdo', label: 'DesiSexVdo 🎥' },
    { key: 'desibabe', label: 'DesiBabe 🍑' },
    { key: 'desihub', label: 'DesiHub 🇮🇳' },
    { key: 'desibf', label: 'DesiBF 💋' },
    { key: 'desileak49', label: 'DesiLeak49 💦' },
    { key: 'mastiraja', label: 'MastiRaja 🍿' }
  ];

  const isAll = userSites.length === allSites.length;
  const keyboard = Markup.inlineKeyboard([
    ...userSiteLabels.map(site => [
      Markup.button.callback(
        `${userSites.includes(site.key) ? '✅' : '⬜'} ${site.label}`,
        `setting_site_${site.key}`
      )
    ]),
    [Markup.button.callback(isAll ? '✅ All Sites' : '⬜ All Sites', 'setting_site_all')],
    [Markup.button.callback('💾 Save & Close', 'setting_save'), Markup.button.callback('🔙 Back', 'back_to_main')]
  ]);

  await ctx.editMessageReplyMarkup(keyboard.reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Toggled ${siteKey}`).catch(() => {});
});

bot.action('setting_save', async (ctx) => {
  await ctx.answerCbQuery('Saved!').catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  await ctx.replyWithMarkdown(
    `✅ *Settings saved!*\n\n` +
    `Your daily digest will now include only selected sites.`,
    getMainMenu(ctx.chat.id)
  ).catch(() => {});
});

export { bot, customQueries, getShortVideoId, videoDownloadUrls };
