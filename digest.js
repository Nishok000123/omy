/**
 * digest.js
 * Compiles a Top 10 "Daily Digest" from all sites and posts it to a Telegram channel.
 * Designed to be called as a Vercel cron job or run manually.
 *
 * Usage:
 *   BOT_TOKEN=xxx DIGEST_CHANNEL_ID=@mychannel node --env-file=.env digest.js
 *
 * Vercel cron (vercel.json):
 *   "crons": [{ "path": "/api/digest", "schedule": "0 9 * * *" }]
 */
import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import {
  scrapeDesiPorn,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja
} from './scraper.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const DIGEST_CHANNEL_ID = process.env.DIGEST_CHANNEL_ID;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

async function runDigest(channelId) {
  const bot = new Telegraf(BOT_TOKEN);
  const limitPerSite = 2; // 2 from each of 8 sites = up to 16 candidates → pick top 10

  console.log('Fetching digest content from all sites...');
  const results = await Promise.allSettled([
    scrapeDesiPorn(1, '', limitPerSite),
    scrapeViralMms(1, limitPerSite),
    scrapeDesiSexVdo(1, '', limitPerSite),
    scrapeDesiBabe(1, limitPerSite),
    scrapeDesiHub(1, limitPerSite),
    scrapeDesiBF(1, '', limitPerSite),
    scrapeDesiLeak49(1, '', limitPerSite),
    scrapeMastiRaja(1, '', limitPerSite)
  ]);

  const posts = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(p => p && p.title && (p.url || p.videoUrl))
    .sort(() => Math.random() - 0.5) // shuffle for variety
    .slice(0, 10);

  if (posts.length === 0) {
    console.log('No posts found for digest.');
    return;
  }

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Header message
  const header = `🔥 *Daily Top 10 – ${today}*\n\n` +
    `Here are today's hottest picks from across the web! 🌶️\n\n` +
    `_Compiled from DesiPorn, ViralMMS, DesiSexVdo, DesiBabe, DesiHub, DesiBF, DesiLeak49 & MastiRaja._`;

  await bot.telegram.sendMessage(channelId, header, { parse_mode: 'Markdown' });

  // Post each item
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const caption = `*${i + 1}. ${escapeMarkdown(post.title)}*\n` +
      `🌐 _${post.siteName || 'Unknown'}_\n\n` +
      `${post.videoUrl ? `[▶️ Watch Video](${post.videoUrl})` : `[🔗 View Post](${post.url})`}`;

    try {
      if (post.thumbnail) {
        await bot.telegram.sendPhoto(channelId, post.thumbnail, {
          caption,
          parse_mode: 'Markdown'
        });
      } else {
        await bot.telegram.sendMessage(channelId, caption, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error(`Failed to post item ${i + 1}:`, err.message);
      // Try plain text fallback
      try {
        await bot.telegram.sendMessage(channelId,
          `${i + 1}. ${post.title}\n${post.url || post.videoUrl}`, {});
      } catch (_) {}
    }

    // Small delay between posts to avoid Telegram rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  const footer = `\n📌 _Subscribe for daily updates!_\n\n` +
    `🤖 Powered by @YourBotUsername`;
  await bot.telegram.sendMessage(channelId, footer, { parse_mode: 'Markdown' }).catch(() => {});

  console.log(`✅ Digest sent! ${posts.length} posts to ${channelId}`);
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// If run directly (not as imported module)
if (DIGEST_CHANNEL_ID) {
  runDigest(DIGEST_CHANNEL_ID).catch(err => {
    console.error('Digest failed:', err.message);
    process.exit(1);
  });
} else {
  console.log('Set DIGEST_CHANNEL_ID env var to run digest. Example: DIGEST_CHANNEL_ID=@mychannel node digest.js');
}

export { runDigest };
