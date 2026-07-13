/**
 * api/groupsend.js
 * Vercel cron endpoint - sends trending videos to group topics by tag matching.
 * Schedule: runs every 6 hours (0 */6 * * *)
 * 
 * For each user who has groupTopics enabled:
 * 1. Get groups where bot is admin
 * 2. For each topic in group, match topic name to tags
 * 3. Scrape trending from each site
 * 4. Send matching videos to matching topics
 */
import { Telegraf } from 'telegraf';
import {
  scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
  scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
  scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja
} from '../scraper.js';
import { getScheduledUsers } from '../kv-storage.js';

// Tag labels mapping
const TAG_LABELS = {
  tamil: 'Tamil',
  mallu: 'Mallu',
  south_indian: 'South Indian',
  young: 'Young',
  // Add more as needed
};

// Site name to tag keywords mapping
const SITE_TAG_KEYWORDS = {
  desiporn: ['tamil', 'mallu', 'south', 'indian', 'desi', 'bhabhi', 'aunty'],
  mmsbee: ['tamil', 'mallu', 'indian', 'desi', 'bhabhi'],
  desipapa: ['tamil', 'mallu', 'indian', 'desi', 'bhabhi', 'aunty'],
  hotpic: ['tamil', 'indian', 'desi', 'viral', 'leaked'],
  viralmms: ['tamil', 'indian', 'desi', 'viral', 'mms'],
  desisexvdo: ['tamil', 'mallu', 'indian', 'desi', 'bhabhi'],
  desibabe: ['tamil', 'indian', 'desi', 'babe'],
  desihub: ['tamil', 'indian', 'desi', 'hub'],
  desibf: ['tamil', 'indian', 'desi', 'bf', 'girlfriend'],
  desileak49: ['tamil', 'indian', 'desi', 'leak', 'leaked'],
  mastiraja: ['tamil', 'mallu', 'indian', 'desi', 'raja']
};

function matchTopicToTags(topicName, siteName) {
  const keywords = SITE_TAG_KEYWORDS[siteName] || [];
  const topicLower = topicName.toLowerCase();
  
  // Check if topic name contains any keyword
  for (const kw of keywords) {
    if (topicLower.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

async function sendVideoToTopic(bot, chatId, topicId, video, siteName) {
  const caption = `🔥 *${video.title}*\n\n` +
    `🌐 *Source*: ${siteName}\n` +
    `📥 *Direct Video*: ${video.videoUrl}`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('🎥 Watch', video.videoUrl)],
    [Markup.button.callback('⬇️ Download', `dl_${getShortId(video.videoUrl)}`)]
  ]);
  
  try {
    // Try sending as video
    await bot.telegram.sendVideo(chatId, video.videoUrl, {
      caption,
      parse_mode: 'Markdown',
      message_thread_id: topicId,
      ...keyboard
    });
    return true;
  } catch (err) {
    console.error(`Failed to send video to topic ${topicId}:`, err.message);
    return false;
  }
}

function getShortId(url) {
  // Simple hash for callback data
  return Buffer.from(url).toString('base64').slice(0, 32);
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
    const { Telegraf, Markup } = await import('telegraf');
    const bot = new Telegraf(BOT_TOKEN);

    const users = await getScheduledUsers();
    const enabledUsers = users.filter(u => u.enabled && u.groupTopics);

    console.log(`Group send: ${enabledUsers.length} users with group topics enabled`);

    if (enabledUsers.length === 0) {
      return res.status(200).json({ ok: true, message: 'No users with group topics enabled' });
    }

    // Define sites to scrape
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

    let totalSent = 0;
    let totalFailed = 0;

    for (const user of enabledUsers) {
      try {
        // Get user's groups (would need to be stored in kv-storage)
        // For now, assume user has groups in user.groups array
        const userGroups = user.groups || [];
        
        for (const group of userGroups) {
          if (!group.chatId || !group.topics) continue;
          
          // Get group's forum topics
          let topics = [];
          try {
            topics = await bot.telegram.getForumTopics(group.chatId);
          } catch (e) {
            console.error(`Failed to get topics for group ${group.chatId}:`, e.message);
            continue;
          }
          
          // Scrape each site and match to topics
          for (const site of sites) {
            try {
              const posts = await site.fn(1, 5).catch(() => []);
              if (!posts.length) continue;
              
              for (const topic of topics) {
                const matchedTag = matchTopicToTags(topic.name, site.key);
                if (!matchedTag) continue;
                
                // Filter posts by tag
                const matchedPosts = posts.filter(p => {
                  const titleLower = (p.title || '').toLowerCase();
                  return titleLower.includes(matchedTag.toLowerCase());
                }).slice(0, 3); // Max 3 per topic per site
                
                for (const post of matchedPosts) {
                  const sent = await sendVideoToTopic(bot, group.chatId, topic.message_thread_id, post, site.key);
                  if (sent) totalSent++;
                  else totalFailed++;
                  
                  // Rate limit
                  await new Promise(r => setTimeout(r, 500));
                }
              }
            } catch (err) {
              console.error(`Error scraping ${site.key}:`, err.message);
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