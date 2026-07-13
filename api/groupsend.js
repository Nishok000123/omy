/**
 * api/groupsend.js
 * Vercel cron — auto-send to forum topics by TAG NAME match.
 * Tamil topic → scrape/search "Tamil" content → send to that thread.
 * Schedule: every 6 hours
 */
import {
  scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
  scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
  scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja,
  scrapeLatestDesiMms, scrapeIndianPorn365, scrapeMmsGram
} from '../scraper.js';
import { getScheduledUsers } from '../kv-storage.js';

/** Search scrapers that accept a text query */
async function scrapeByTag(tag, limitPerSite = 3) {
  const q = String(tag || '').trim();
  if (!q) return [];

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
    // non-search sites: pull latest then filter by title
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
  // Prefer title/tag match; keep some search hits even if title miss
  const matched = posts.filter(p =>
    p.title.toLowerCase().includes(tagLower) ||
    (p.url || '').toLowerCase().includes(tagLower)
  );
  const pool = matched.length ? matched : posts;
  // shuffle lightly
  return pool.sort(() => Math.random() - 0.5).slice(0, 6);
}

async function sendPostToTopic(bot, chatId, topicId, post, tagName) {
  const watch = post.videoUrl || post.url;
  const caption =
    `🔥 *${escapeMd(post.title)}*\n\n` +
    `🏷 *Topic*: ${escapeMd(tagName)}\n` +
    `🌐 *Source*: ${escapeMd(post.siteName || 'Unknown')}\n` +
    (watch ? `📥 [Watch](${watch})` : '');

  const opts = {
    caption,
    parse_mode: 'Markdown',
    message_thread_id: topicId
  };

  try {
    if (post.videoUrl && /\.mp4(\?|$)/i.test(post.videoUrl)) {
      await bot.telegram.sendVideo(chatId, post.videoUrl, opts);
    } else if (post.thumbnail && !String(post.thumbnail).startsWith('data:')) {
      await bot.telegram.sendPhoto(chatId, post.thumbnail, opts);
    } else {
      await bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        message_thread_id: topicId,
        disable_web_page_preview: false
      });
    }
    return true;
  } catch (err) {
    // fallback plain text
    try {
      await bot.telegram.sendMessage(
        chatId,
        `${post.title}\n${tagName}\n${watch || ''}`,
        { message_thread_id: topicId }
      );
      return true;
    } catch (e2) {
      console.error(`Failed topic ${topicId}:`, err.message);
      return false;
    }
  }
}

function escapeMd(s) {
  return String(s || '').replace(/([_*`\[])/g, '\\$1');
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && req.method === 'POST' && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN not configured' });
  }

  try {
    const { Telegraf } = await import('telegraf');
    const bot = new Telegraf(BOT_TOKEN);

    const users = await getScheduledUsers();
    const enabledUsers = users.filter(u => u.enabled && u.groupTopics);

    console.log(`Group send: ${enabledUsers.length} users with group topics enabled`);

    if (enabledUsers.length === 0) {
      return res.status(200).json({ ok: true, message: 'No users with group topics enabled' });
    }

    let totalSent = 0;
    let totalFailed = 0;

    for (const user of enabledUsers) {
      try {
        const userGroups = user.groups || [];
        for (const group of userGroups) {
          if (!group.chatId) continue;

          // Prefer stored topics (name + message_thread_id)
          let topics = Array.isArray(group.topics) ? group.topics.filter(t => t.name && t.message_thread_id) : [];

          if (topics.length === 0) {
            console.log(`No topics configured for group ${group.chatId} — skip (use /settopic)`);
            continue;
          }

          for (const topic of topics) {
            const tagName = topic.name;
            console.log(`Topic "${tagName}" thread ${topic.message_thread_id} — scraping by tag`);
            try {
              const posts = await scrapeByTag(tagName, 3);
              if (!posts.length) {
                console.log(`  no posts for tag ${tagName}`);
                continue;
              }
              // max 3 per topic per run
              for (const post of posts.slice(0, 3)) {
                const ok = await sendPostToTopic(
                  bot,
                  group.chatId,
                  topic.message_thread_id,
                  post,
                  tagName
                );
                if (ok) totalSent++;
                else totalFailed++;
                await new Promise(r => setTimeout(r, 800));
              }
            } catch (err) {
              console.error(`Topic ${tagName} error:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error(`Error processing user ${user.userId}:`, err.message);
      }
    }

    res.status(200).json({ ok: true, sent: totalSent, failed: totalFailed, users: enabledUsers.length });
  } catch (err) {
    console.error('Group send cron error:', err);
    res.status(500).json({ error: err.message });
  }
}
