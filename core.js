import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import axios from 'axios';
import {
  scrapeKamaClips,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja
} from './scraper.js';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is missing in the env configuration.');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

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

const HELP_TEXT = `📖 *Usage Instructions*:\n\n` +
  `1. Click on any site button to open the page selector.\n` +
  `2. Select a quick tag directly from the front menu.\n` +
  `3. Or, **type any search word** (e.g. \`bhabhi\`) and send it to search the supported sites!\n` +
  `4. Toggle the **Auto-Delete Timer** between Off, 15 Min, or 30 Min to automatically wipe media from the chat.\n` +
  `5. At the bottom of the last post, use pagination controls to scroll pages.\n\n` +
  `Use /start to open the main menu.`;

// In-memory store for chat settings (default to 15 minutes auto-delete)
const chatSettings = {};

// Map to store custom query IDs to avoid exceeding Telegram's 64-byte callback query data limit
const customQueries = {};
let queryCounter = 0;

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

// Helper to schedule message deletion
function scheduleDeletion(ctx, messageIds, minutes) {
  if (!minutes || minutes <= 0) return;
  setTimeout(async () => {
    await Promise.allSettled(
      messageIds.map((msgId) => ctx.telegram.deleteMessage(ctx.chat.id, msgId))
    );
  }, minutes * 60 * 1000);
}

// Consolidated AIO Scraper (shuffles/combines posts from all 8 sites)
async function scrapeAIO(page = 1, filterType = 'latest') {
  const limitPerSite = 3;
  const results = await Promise.all([
    scrapeKamaClips(page, '', limitPerSite).catch(() => []),
    scrapeViralMms(page, limitPerSite).catch(() => []),
    scrapeDesiSexVdo(page, '', limitPerSite).catch(() => []),
    scrapeDesiBabe(page, limitPerSite).catch(() => []),
    scrapeDesiHub(page, limitPerSite).catch(() => []),
    scrapeDesiBF(page, '', limitPerSite).catch(() => []),
    scrapeDesiLeak49(page, '', limitPerSite).catch(() => []),
    scrapeMastiRaja(page, '', limitPerSite).catch(() => [])
  ]);

  const mergedPosts = mergeResults(results);

  return mergedPosts.slice(0, 10);
}

// Consolidated AIO Tag/Text Search Scraper (combines search results from the 5 searchable sites)
async function searchAllSites(page = 1, query = '') {
  const limitPerSite = 3;
  const results = await Promise.all([
    scrapeKamaClips(page, query, limitPerSite).catch(() => []),
    scrapeDesiSexVdo(page, query, limitPerSite).catch(() => []),
    scrapeDesiBF(page, query, limitPerSite).catch(() => []),
    scrapeDesiLeak49(page, query, limitPerSite).catch(() => []),
    scrapeMastiRaja(page, query, limitPerSite).catch(() => [])
  ]);

  const mergedPosts = mergeResults(results);

  return mergedPosts.slice(0, 10);
}

// Generate the main menu dynamically based on chat settings
function getMainMenu(chatId) {
  const settings = chatSettings[chatId] || { autoDeleteMinutes: 15 };
  let deleteLabel = '⏳ Auto-Delete: Off';
  if (settings.autoDeleteMinutes === 15) deleteLabel = '⏳ Auto-Delete: 15 Min';
  else if (settings.autoDeleteMinutes === 30) deleteLabel = '⏳ Auto-Delete: 30 Min';

  return Markup.inlineKeyboard([
    // Row 1: Unified All-in-One consolidated feeds!
    [
      Markup.button.callback('🔥 Trending (All-in-One)', 'scrape_trending_all_in_one_1'),
      Markup.button.callback('🌟 Popular (All-in-One)', 'scrape_popular_all_in_one_1')
    ],
    // Rows 2 & 3: Individual Sites
    [Markup.button.callback('KamaClips 🔞', 'site_kamaclips'), Markup.button.callback('ViralMMS 🎬', 'site_viralmms')],
    [Markup.button.callback('DesiSexVdo 🎥', 'site_desisexvdo'), Markup.button.callback('DesiBabe 🍑', 'site_desibabe')],
    [Markup.button.callback('DesiHub 🇮🇳', 'site_desihub'), Markup.button.callback('DesiBF 💋', 'site_desibf')],
    [Markup.button.callback('DesiLeak49 💦', 'site_desileak49'), Markup.button.callback('MastiRaja 🍿', 'site_mastiraja')],
    // Predefined Tags Row directly on the front menu
    [Markup.button.callback('Tamil 🇮🇳', 'tag_tamil'), Markup.button.callback('Mallu 🥥', 'tag_mallu')],
    [Markup.button.callback('South Indian 🌴', 'tag_south_indian'), Markup.button.callback('Young 👧', 'tag_young')],
    // Toggle auto-delete setting and Help
    [Markup.button.callback(deleteLabel, 'toggle_autodelete'), Markup.button.callback('❓ Help & Usage', 'help')]
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
  const welcomeText = `👋 *Welcome to the Desi Video Scraper Bot!*\n\n` +
    `Select a site from the menu below, click on one of the quick tags, or **type a custom search word** directly to search the sites and get results!`;
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
  const welcomeText = `👋 *Welcome to the Desi Video Scraper Bot!*\n\n` +
    `Select a site from the menu below, click on one of the quick tags, or **type a custom search word** directly to search the sites and get results!`;
  
  if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.photo) {
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

  const welcomeText = `👋 *Welcome to the Desi Video Scraper Bot!*\n\n` +
    `Select a site from the menu below, click on one of the quick tags, or **type a custom search word** directly to search the sites and get results!`;

  await ctx.editMessageText(welcomeText, {
    parse_mode: 'Markdown',
    ...getMainMenu(chatId)
  }).catch(() => {});
});

// Setup site triggers to load page selectors
bot.action('site_kamaclips', (ctx) => sendPageSelector(ctx, 'KamaClips', 'kamaclips'));
bot.action('site_viralmms', (ctx) => sendPageSelector(ctx, 'ViralMMS', 'viralmms'));
bot.action('site_desisexvdo', (ctx) => sendPageSelector(ctx, 'DesiSexVdo', 'desisexvdo'));
bot.action('site_desibabe', (ctx) => sendPageSelector(ctx, 'DesiBabe', 'desibabe'));
bot.action('site_desihub', (ctx) => sendPageSelector(ctx, 'DesiHub', 'desihub'));
bot.action('site_desibf', (ctx) => sendPageSelector(ctx, 'DesiBF', 'desibf'));
bot.action('site_desileak49', (ctx) => sendPageSelector(ctx, 'DesiLeak49', 'desileak49'));
bot.action('site_mastiraja', (ctx) => sendPageSelector(ctx, 'MastiRaja', 'mastiraja'));

bot.action(/^tag_(.+)$/, async (ctx) => {
  const tagKey = ctx.match[1];
  const tagLabel = TAG_LABELS[tagKey] || tagKey;
  await ctx.answerCbQuery().catch(() => {});

  const text = `🔍 *Search Tag: ${tagLabel}*\n\nSelect which site you want to search for *"${tagLabel}"*:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Combined Search (All Sites)', `search_all_${tagKey}_1`)],
    [
      Markup.button.callback('KamaClips 🔞', `search_kamaclips_${tagKey}_1`),
      Markup.button.callback('DesiSexVdo 🎥', `search_desisexvdo_${tagKey}_1`)
    ],
    [
      Markup.button.callback('DesiBF 💋', `search_desibf_${tagKey}_1`),
      Markup.button.callback('DesiLeak49 💦', `search_desileak49_${tagKey}_1`)
    ],
    [
      Markup.button.callback('MastiRaja 🍿', `search_mastiraja_${tagKey}_1`)
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

  queryCounter++;
  const queryId = `q${queryCounter}`;
  customQueries[queryId] = text;

  // Prune map if too large
  if (queryCounter > 5000) {
    const keys = Object.keys(customQueries);
    for (let i = 0; i < 1000; i++) {
      delete customQueries[keys[i]];
    }
  }

  const responseText = `🔍 *Search results for: "${text}"*\n\nSelect which site you want to search on:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Combined Search (All Sites)', `csearch_all_${queryId}_1`)],
    [
      Markup.button.callback('KamaClips 🔞', `csearch_kamaclips_${queryId}_1`),
      Markup.button.callback('DesiSexVdo 🎥', `csearch_desisexvdo_${queryId}_1`)
    ],
    [
      Markup.button.callback('DesiBF 💋', `csearch_desibf_${queryId}_1`),
      Markup.button.callback('DesiLeak49 💦', `csearch_desileak49_${queryId}_1`)
    ],
    [
      Markup.button.callback('MastiRaja 🍿', `csearch_mastiraja_${queryId}_1`)
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
    const posts = tag ? await scrapeFn(page, tag) : await scrapeFn(page);
    
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

    // Send posts one by one
    for (let i = 0; i < posts.length - 1; i++) {
      const post = posts[i];
      const caption = `🔥 *${i + 1}. ${post.title}*\n\n` +
        `🌐 *Source*: ${post.siteName || siteName}\n` +
        `📄 *Page*: ${page}\n` +
        (tag ? `🏷️ *Tag/Search*: ${tag}\n` : '') +
        `🔗 [Original Post](${post.url})\n\n` +
        `📥 *Direct Video URL* (tap to copy):\n` +
        `\`${post.videoUrl}\``;

      let keyboard = null;
      if (post.videoUrl) {
        const shortId = getShortVideoId(post.videoUrl);
        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.url('🎥 Watch Direct Video', post.videoUrl),
            Markup.button.callback('⬇️ Download to Telegram', `dl_${shortId}`)
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
        // Try native video first, then fallback to photo, then to text
        try {
          if (post.videoUrl) {
            msg = await ctx.replyWithVideo(post.videoUrl, replyOptions);
          } else {
            throw new Error("No video url");
          }
        } catch (videoErr) {
          if (post.thumbnail) {
            msg = await ctx.replyWithPhoto(post.thumbnail, replyOptions).catch(() => {});
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
    }

    // Send the last post with pagination controls attached
    const lastIndex = posts.length - 1;
    const lastPost = posts[lastIndex];
    const lastCaption = `🔥 *${lastIndex + 1}. ${lastPost.title}*\n\n` +
      `🌐 *Source*: ${lastPost.siteName || siteName}\n` +
      `📄 *Page*: ${page}\n` +
      (tag ? `🏷️ *Tag/Search*: ${tag}\n` : '') +
      `🔗 [Original Post](${lastPost.url})\n\n` +
      `📥 *Direct Video URL* (tap to copy):\n` +
      `\`${lastPost.videoUrl}\``;

    const siteKey = siteName.toLowerCase();
    const paginationKeyboard = getPaginationKeyboard(siteKey, page, tag, queryId, lastPost.videoUrl);

    try {
      let msgLast = null;
      try {
        if (lastPost.videoUrl) {
          msgLast = await ctx.replyWithVideo(lastPost.videoUrl, {
            caption: lastCaption,
            parse_mode: 'Markdown',
            ...paginationKeyboard
          });
        } else {
          throw new Error("No video url");
        }
      } catch (videoErr) {
        if (lastPost.thumbnail) {
          msgLast = await ctx.replyWithPhoto(lastPost.thumbnail, {
            caption: lastCaption,
            parse_mode: 'Markdown',
            ...paginationKeyboard
          }).catch(() => {});
        } else {
          msgLast = await ctx.replyWithMarkdown(lastCaption, paginationKeyboard).catch(() => {});
        }
      }
      if (msgLast) sentMessageIds.push(msgLast.message_id);
    } catch (err) {
      const msgLast = await ctx.replyWithMarkdown(lastCaption, paginationKeyboard).catch(() => {});
      if (msgLast) sentMessageIds.push(msgLast.message_id);
    }

    // Schedule deletion if enabled
    const settings = chatSettings[ctx.chat.id] || { autoDeleteMinutes: 15 };
    if (settings.autoDeleteMinutes > 0) {
      scheduleDeletion(ctx, sentMessageIds, settings.autoDeleteMinutes);
      const selfDestructMsg = await ctx.replyWithMarkdown(
        `⏳ _These messages will auto-delete in *${settings.autoDeleteMinutes} minutes*._`
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
      `❌ An error occurred: ${err.message}`,
      getMainMenu(ctx.chat.id)
    ).catch(() => {});
  }
}

// Register generic page scraper action handler
bot.action(/^scrape_([a-z0-9_]+)_(\d+)$/, async (ctx) => {
  const siteKey = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  
  let siteName = '';
  let scrapeFn = null;

  if (siteKey === 'trending_all_in_one') {
    siteName = 'Trending (All-in-One)';
    scrapeFn = (p) => scrapeAIO(p, 'trending');
  } else if (siteKey === 'popular_all_in_one') {
    siteName = 'Popular (All-in-One)';
    scrapeFn = (p) => scrapeAIO(p, 'popular');
  } else if (siteKey === 'kamaclips') {
    siteName = 'KamaClips';
    scrapeFn = scrapeKamaClips;
  } else if (siteKey === 'viralmms') {
    siteName = 'ViralMMS';
    scrapeFn = scrapeViralMms;
  } else if (siteKey === 'desisexvdo') {
    siteName = 'DesiSexVdo';
    scrapeFn = scrapeDesiSexVdo;
  } else if (siteKey === 'desibabe') {
    siteName = 'DesiBabe';
    scrapeFn = scrapeDesiBabe;
  } else if (siteKey === 'desihub') {
    siteName = 'DesiHub';
    scrapeFn = scrapeDesiHub;
  } else if (siteKey === 'desibf') {
    siteName = 'DesiBF';
    scrapeFn = scrapeDesiBF;
  } else if (siteKey === 'desileak49') {
    siteName = 'DesiLeak49';
    scrapeFn = scrapeDesiLeak49;
  } else if (siteKey === 'mastiraja') {
    siteName = 'MastiRaja';
    scrapeFn = scrapeMastiRaja;
  }

  if (scrapeFn) {
    await handleScrapeAction(ctx, siteName, page, scrapeFn);
  } else {
    await ctx.answerCbQuery('Invalid site selection.').catch(() => {});
  }
});

const validSitesPattern = 'all|kamaclips|viralmms|desisexvdo|desibabe|desihub|desibf|desileak49|mastiraja|trending_all_in_one|popular_all_in_one';

// Register generic tag search handler
bot.action(new RegExp('^search_(' + validSitesPattern + ')_(.+)_(\\d+)$'), async (ctx) => {
  const siteKey = ctx.match[1];
  const tagKey = ctx.match[2];
  const page = parseInt(ctx.match[3], 10);

  let siteName = '';
  let scrapeFn = null;

  if (siteKey === 'all') {
    siteName = 'All Sites';
    scrapeFn = searchAllSites;
  } else if (siteKey === 'kamaclips') {
    siteName = 'KamaClips';
    scrapeFn = scrapeKamaClips;
  } else if (siteKey === 'desisexvdo') {
    siteName = 'DesiSexVdo';
    scrapeFn = scrapeDesiSexVdo;
  } else if (siteKey === 'desibf') {
    siteName = 'DesiBF';
    scrapeFn = scrapeDesiBF;
  } else if (siteKey === 'desileak49') {
    siteName = 'DesiLeak49';
    scrapeFn = scrapeDesiLeak49;
  } else if (siteKey === 'mastiraja') {
    siteName = 'MastiRaja';
    scrapeFn = scrapeMastiRaja;
  }

  const tagLabel = TAG_LABELS[tagKey] || tagKey;

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
    await ctx.answerCbQuery('Search query expired. Please type a new search word.').catch(() => {});
    return;
  }

  let siteName = '';
  let scrapeFn = null;

  if (siteKey === 'all') {
    siteName = 'All Sites';
    scrapeFn = searchAllSites;
  } else if (siteKey === 'kamaclips') {
    siteName = 'KamaClips';
    scrapeFn = scrapeKamaClips;
  } else if (siteKey === 'desisexvdo') {
    siteName = 'DesiSexVdo';
    scrapeFn = scrapeDesiSexVdo;
  } else if (siteKey === 'desibf') {
    siteName = 'DesiBF';
    scrapeFn = scrapeDesiBF;
  } else if (siteKey === 'desileak49') {
    siteName = 'DesiLeak49';
    scrapeFn = scrapeDesiLeak49;
  } else if (siteKey === 'mastiraja') {
    siteName = 'MastiRaja';
    scrapeFn = scrapeMastiRaja;
  }

  if (scrapeFn) {
    await handleScrapeAction(ctx, siteName, page, scrapeFn, queryText, queryId);
  } else {
    await ctx.answerCbQuery('Invalid site selection.').catch(() => {});
  }
});

bot.action(/^dl_(v\d+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  const videoUrl = videoDownloadUrls.get(shortId);

  if (!videoUrl) {
    return ctx.answerCbQuery('Download link expired. Please search again.').catch(() => {});
  }

  await ctx.answerCbQuery('Downloading video to Telegram... This may take a minute.').catch(() => {});

  const statusMsg = await ctx.replyWithMarkdown('⏳ _Downloading video..._').catch(() => {});

  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    await ctx.replyWithVideo({ source: response.data }, {
      caption: '✅ *Video Downloaded Successfully*',
      parse_mode: 'Markdown'
    });

    if (statusMsg) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }
  } catch (error) {
    console.error('Error downloading video:', error);
    if (statusMsg) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }
    await ctx.replyWithMarkdown('❌ Failed to download the video. The file might be too large or the server is blocking requests.').catch(() => {});
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

export { bot, customQueries, getShortVideoId, videoDownloadUrls };
