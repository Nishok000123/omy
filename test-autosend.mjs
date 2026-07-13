import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { getScheduledUsers } from './kv-storage.js';
import {
  scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
  scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
  scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja
} from './scraper.js';

dotenv.config();

async function testAutoSend() {
  console.log('=== Testing Auto-Send ===\n');
  
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('No BOT_TOKEN');
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  const users = await getScheduledUsers();
  const enabledUsers = users.filter(u => u.enabled);

  console.log(`Total users: ${users.length}`);
  console.log(`Enabled users: ${enabledUsers.length}`);

  if (enabledUsers.length === 0) {
    console.log('No enabled users to send to');
    return;
  }

  // Test scraping all sites
  console.log('\n--- Scraping all sites ---');
  const sites = [
    { key: 'desiporn', fn: scrapeDesiPorn },
    { key: 'mmsbee', fn: scrapeMMSBee },
    { key: 'desipapa', fn: scrapeDesiPapa },
    { key: 'hotpic', fn: scrapeHotpic },
    { key: 'viralmms', fn: scrapeViralMms },
    { key: 'desisexvdo', fn: scrapeDesiSexVdo },
    { key: 'desibabe', fn: scrapeDesiBabe },
    { key: 'desihub', fn: scrapeDesiHub },
    { key: 'desibf', fn: scrapeDesiBF },
    { key: 'desileak49', fn: scrapeDesiLeak49 },
    { key: 'mastiraja', fn: scrapeMastiRaja }
  ];

  for (const site of sites) {
    try {
      const posts = await site.fn(1, 2).catch(() => []);
      console.log(`${site.key}: ${posts.length} posts`);
    } catch (e) {
      console.log(`${site.key}: ERROR - ${e.message}`);
    }
  }

  // Test sending to first enabled user
  const user = enabledUsers[0];
  console.log(`\n--- Test sending to user ${user.userId} (chat ${user.chatId}) ---`);
  
  const sitesToScrape = [
    { key: 'desiporn', fn: scrapeDesiPorn },
    { key: 'hotpic', fn: scrapeHotpic },
    { key: 'mmsbee', fn: scrapeMMSBee }
  ];

  const limitPerSite = 1;
  const results = await Promise.allSettled(
    sitesToScrape.map(s => s.fn(1, '', limitPerSite))
  );

  const posts = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(p => p && p.title && (p.url || p.videoUrl))
    .slice(0, 5);

  console.log(`Posts to send: ${posts.length}`);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    console.log(`${i+1}. ${post.title?.slice(0,50)}... | ${post.siteName} | video: ${!!post.videoUrl}`);
  }

  // Actually send one test message
  if (posts.length > 0) {
    const post = posts[0];
    try {
      const escapeMd = (text) => text?.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&') || '';
      const title = escapeMd(post.title);
      const siteName = escapeMd(post.siteName);
      await bot.telegram.sendMessage(user.chatId, 
        `🧪 *Test Auto-Send*\n\n` +
        `*${title}*\n` +
        `Source: ${siteName}\n` +
        `Video: ${post.videoUrl || post.url}`,
        { parse_mode: 'Markdown' }
      );
      console.log('\n✅ Test message sent!');
    } catch (e) {
      console.error('\n❌ Failed to send:', e.message);
    }
  }
}

testAutoSend().then(() => {
  console.log('\nDone');
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});