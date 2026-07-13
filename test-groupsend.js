/**
 * test-groupsend.js — manual group topics auto-send
 * Tag name → scrape that tag → send to matching topic thread
 * Usage: node test-groupsend.js
 */
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import {
  scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
  scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
  scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja,
  scrapeLatestDesiMms, scrapeIndianPorn365, scrapeMmsGram
} from './scraper.js';
import { getScheduledUsers } from './kv-storage.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in .env');
  process.exit(1);
}

async function scrapeByTag(tag, limitPerSite = 2) {
  const q = String(tag || '').trim();
  const results = await Promise.allSettled([
    scrapeDesiPorn(1, q, limitPerSite),
    scrapeMMSBee(1, q, limitPerSite),
    scrapeDesiPapa(1, q, limitPerSite),
    scrapeDesiSexVdo(1, q, limitPerSite),
    scrapeDesiBF(1, q, limitPerSite),
    scrapeDesiLeak49(1, q, limitPerSite),
    scrapeMastiRaja(1, q, limitPerSite),
    scrapeLatestDesiMms(1, q, limitPerSite),
    scrapeIndianPorn365(1, q, limitPerSite),
    scrapeHotpic(1, limitPerSite),
    scrapeViralMms(1, limitPerSite),
    scrapeDesiBabe(1, limitPerSite),
    scrapeDesiHub(1, limitPerSite),
    scrapeMmsGram(1, 'desi-new', limitPerSite)
  ]);

  const posts = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value || [])
    .filter(p => p && p.title && (p.videoUrl || p.url));

  const tagLower = q.toLowerCase();
  const matched = posts.filter(p =>
    p.title.toLowerCase().includes(tagLower) ||
    (p.url || '').toLowerCase().includes(tagLower)
  );
  return (matched.length ? matched : posts).sort(() => Math.random() - 0.5).slice(0, 4);
}

async function testGroupSend() {
  console.log('🚀 Group topic auto-send test (tag → topic)\n');
  const bot = new Telegraf(BOT_TOKEN);
  const users = await getScheduledUsers();
  const enabledUsers = users.filter(u => u.enabled && u.groupTopics);

  console.log(`📊 Users with group topics: ${enabledUsers.length}`);
  if (!enabledUsers.length) {
    console.log('Enable group topics + /setgroup + /settopic first');
    process.exit(0);
  }

  let totalSent = 0;
  let totalFailed = 0;

  for (const user of enabledUsers) {
    console.log(`\n👤 user ${user.userId}`);
    for (const group of user.groups || []) {
      if (!group.chatId) continue;
      const topics = (group.topics || []).filter(t => t.name && t.message_thread_id);
      console.log(`  group ${group.chatId} topics: ${topics.map(t => t.name).join(', ') || '(none)'}`);

      if (!topics.length) {
        console.log('  ⚠️ no topics — run /settopic inside each forum topic');
        continue;
      }

      for (const topic of topics) {
        console.log(`\n  🎯 topic "${topic.name}" thread ${topic.message_thread_id}`);
        const posts = await scrapeByTag(topic.name, 2);
        console.log(`     posts: ${posts.length}`);
        for (const post of posts.slice(0, 2)) {
          const watch = post.videoUrl || post.url;
          const caption = `🔥 *${post.title}*\n\n🏷 ${topic.name}\n🌐 ${post.siteName || ''}\n📥 ${watch || ''}`;
          try {
            const opts = { caption, parse_mode: 'Markdown', message_thread_id: topic.message_thread_id };
            if (post.videoUrl && /\.mp4(\?|$)/i.test(post.videoUrl)) {
              await bot.telegram.sendVideo(group.chatId, post.videoUrl, opts);
            } else if (post.thumbnail && !String(post.thumbnail).startsWith('data:')) {
              await bot.telegram.sendPhoto(group.chatId, post.thumbnail, opts);
            } else {
              await bot.telegram.sendMessage(group.chatId, caption, {
                parse_mode: 'Markdown',
                message_thread_id: topic.message_thread_id
              });
            }
            console.log(`     ✅ ${post.title.slice(0, 50)}`);
            totalSent++;
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error(`     ❌ ${err.message}`);
            totalFailed++;
          }
        }
      }
    }
  }

  console.log(`\n🎉 done sent=${totalSent} failed=${totalFailed}`);
  process.exit(0);
}

testGroupSend().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
