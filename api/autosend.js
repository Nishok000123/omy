/**
 * api/autosend.js
 * Vercel cron endpoint - sends personalized daily digest to all subscribed users.
 * Schedule: runs at 03:30 UTC (09:00 IST) daily via vercel.json cron.
 * 
 * Each user gets a customized Top 10 sent to their private chat.
 * Users can configure which sites to include via /settings command.
 */
import { runDigest } from '../digest.js';
import { getScheduledUsers } from '../kv-storage.js';

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  // Only allow Vercel cron or manual GET with secret
  if (cronSecret && req.method === 'POST' && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN not configured' });
  }

  try {
    // Import Telegraf dynamically (lighter for serverless)
    const { Telegraf } = await import('telegraf');
    const bot = new Telegraf(BOT_TOKEN);

    const users = await getScheduledUsers();
    const enabledUsers = users.filter(u => u.enabled);

    console.log(`Auto-send: ${enabledUsers.length} users subscribed`);

    if (enabledUsers.length === 0) {
      return res.status(200).json({ ok: true, message: 'No subscribed users' });
    }

    // Fetch the digest posts once - all sites
    const {
      scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
      scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
      scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja,
      scrapeLatestDesiMms, scrapeIndianPorn365, scrapeMmsGram
    } = await import('../scraper.js');

    const limitPerSite = 2;
    const results = await Promise.allSettled([
      scrapeDesiPorn(1, '', limitPerSite),
      scrapeMMSBee(1, '', limitPerSite),
      scrapeDesiPapa(1, '', limitPerSite),
      scrapeHotpic(1, limitPerSite),
      scrapeViralMms(1, limitPerSite),
      scrapeDesiSexVdo(1, '', limitPerSite),
      scrapeDesiBabe(1, limitPerSite),
      scrapeDesiHub(1, limitPerSite),
      scrapeDesiBF(1, '', limitPerSite),
      scrapeDesiLeak49(1, '', limitPerSite),
      scrapeMastiRaja(1, '', limitPerSite),
      scrapeLatestDesiMms(1, 'most-viewed', limitPerSite),
      scrapeIndianPorn365(1, 'latest', limitPerSite),
      scrapeMmsGram(1, 'latest-trending', limitPerSite)
    ]);

    const posts = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(p => p && p.title && (p.url || p.videoUrl))
      .sort(() => Math.random() - 0.5)
      .slice(0, 10);

    if (posts.length === 0) {
      return res.status(200).json({ ok: true, message: 'No posts found' });
    }

    // Send to each user
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    let sent = 0;
    let failed = 0;

    for (const user of enabledUsers) {
      try {
        // Filter posts based on user's site preferences
        const userSites = user.sites || ['desiporn', 'mmsbee', 'desipapa', 'hotpic', 'viralmms', 'desisexvdo', 'desibabe', 'desihub', 'desibf', 'desileak49', 'mastiraja', 'latestdesimms', 'mmsgram', 'indianporn365'];
        const normalizeSite = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const userPosts = posts.filter(p => {
          const key = normalizeSite(p.siteName);
          return userSites.some(s => normalizeSite(s) === key || key.includes(normalizeSite(s)));
        });
        
        const header = `🌅 *Good Morning! Daily Top ${userPosts.length} – ${today}*\n\n` +
          `Your personalized daily digest from across the web! ☕\n\n` +
          `_Compiled from ${userSites.length} sites just for you._`;

        await bot.telegram.sendMessage(user.chatId, header, { parse_mode: 'Markdown' });

        for (let i = 0; i < userPosts.length; i++) {
          const post = userPosts[i];
          const caption = `*${i + 1}. ${escapeMarkdown(post.title)}*\n` +
            `🌐 _${post.siteName || 'Unknown'}_\n\n` +
            `${post.videoUrl ? `[▶️ Watch Video](${post.videoUrl})` : `[🔗 View Post](${post.url})`}`;

          try {
            if (post.thumbnail) {
              await bot.telegram.sendPhoto(user.chatId, post.thumbnail, {
                caption,
                parse_mode: 'Markdown'
              });
            } else {
              await bot.telegram.sendMessage(user.chatId, caption, { parse_mode: 'Markdown' });
            }
          } catch (err) {
            // Try plain text fallback
            await bot.telegram.sendMessage(user.chatId,
              `${i + 1}. ${post.title}\n${post.url || post.videoUrl}`, {}).catch(() => {});
          }

          await new Promise(r => setTimeout(r, 300)); // Rate limit
        }

        const footer = `\n📌 _Reply with /daily to toggle this daily digest._\n\n` +
          `🤖 Powered by your bot`;
        await bot.telegram.sendMessage(user.chatId, footer, { parse_mode: 'Markdown' }).catch(() => {});

        sent++;
        await new Promise(r => setTimeout(r, 500)); // Space between users
      } catch (err) {
        console.error(`Failed to send to user ${user.userId}:`, err.message);
        failed++;
      }
    }

    res.status(200).json({ ok: true, sent, failed, total: enabledUsers.length });
  } catch (err) {
    console.error('Auto-send cron error:', err);
    res.status(500).json({ error: err.message });
  }
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
