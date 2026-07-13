/**
 * test-groupsend.js
 * Manual trigger for group topics auto-send (tests api/groupsend.js logic)
 * 
 * Usage: node test-groupsend.js
 */
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import {
  scrapeDesiPorn, scrapeMMSBee, scrapeDesiPapa, scrapeHotpic,
  scrapeViralMms, scrapeDesiSexVdo, scrapeDesiBabe,
  scrapeDesiHub, scrapeDesiBF, scrapeDesiLeak49, scrapeMastiRaja
} from './scraper.js';
import { getScheduledUsers } from './kv-storage.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in .env');
  process.exit(1);
}

// Tag matching logic (from api/groupsend.js)
const TAG_LABELS = {
  tamil: 'Tamil',
  mallu: 'Mallu',
  south_indian: 'South Indian',
  young: 'Young'
};

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
  
  for (const kw of keywords) {
    if (topicLower.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

async function testGroupSend() {
  console.log('🚀 Starting manual group send test...\n');
  
  const bot = new Telegraf(BOT_TOKEN);
  
  // Get users with group topics enabled
  const users = await getScheduledUsers();
  const enabledUsers = users.filter(u => u.enabled && u.groupTopics);
  
  console.log(`📊 Found ${enabledUsers.length} user(s) with group topics enabled`);
  
  if (enabledUsers.length === 0) {
    console.log('❌ No users with group topics enabled. Enable in bot settings first.');
    process.exit(0);
  }
  
  // Sites to scrape
  const sites = [
    { key: 'desiporn', fn: scrapeDesiPorn },
    { key: 'hotpic', fn: scrapeHotpic },
    { key: 'desisexvdo', fn: scrapeDesiSexVdo },
    { key: 'desibabe', fn: scrapeDesiBabe },
    { key: 'desibf', fn: scrapeDesiBF },
    { key: 'desileak49', fn: scrapeDesiLeak49 },
    { key: 'mastiraja', fn: scrapeMastiRaja }
  ];
  
  let totalSent = 0;
  let totalFailed = 0;
  
  for (const user of enabledUsers) {
    console.log(`\n👤 Processing user ${user.userId}...`);
    
    const userGroups = user.groups || [];
    if (userGroups.length === 0) {
      console.log('  ⚠️  No groups configured for this user');
      continue;
    }
    
    for (const group of userGroups) {
      if (!group.chatId) {
        console.log('  ⚠️  Group missing chatId, skipping');
        continue;
      }
      
      console.log(`\n  📍 Group: ${group.chatId}`);
      
      // Get forum topics
      let topics = [];
      try {
        const chat = await bot.telegram.getChat(group.chatId);
        console.log(`  ℹ️  Group: ${chat.title || 'Unknown'}`);
        
        if (chat.is_forum) {
          console.log(`  ✅ Forum group detected`);
          // Note: Telegram Bot API doesn't have getForumTopics method in standard library
          // We'll need to use message_thread_id when sending
          // For now, simulate with common topic names
          topics = [
            { name: 'Tamil', message_thread_id: null },  // Will be determined when sending
            { name: 'General', message_thread_id: null }
          ];
          console.log(`  📋 Simulating topics: ${topics.map(t => t.name).join(', ')}`);
        } else {
          console.log(`  ⚠️  Not a forum group - will send to main chat`);
        }
      } catch (e) {
        console.error(`  ❌ Failed to get group info: ${e.message}`);
        continue;
      }
      
      // Scrape sites and send
      for (const site of sites) {
        try {
          console.log(`\n    🔍 Scraping ${site.key}...`);
          const posts = await site.fn(1, '', 5).catch(() => []);
          
          if (!posts || posts.length === 0) {
            console.log(`    ⚠️  No posts from ${site.key}`);
            continue;
          }
          
          console.log(`    ✅ Got ${posts.length} posts from ${site.key}`);
          
          // If forum group, match to topics
          if (topics.length > 0) {
            for (const topic of topics) {
              const matchedTag = matchTopicToTags(topic.name, site.key);
              
              if (!matchedTag) {
                console.log(`    ⏭️  No tag match for topic "${topic.name}"`);
                continue;
              }
              
              console.log(`    🎯 Matched tag "${matchedTag}" for topic "${topic.name}"`);
              
              // Loose match: if topic matches site tags, send top posts (no title filter)
              const matchedPosts = posts.slice(0, 2); // Max 2 per topic per site
              
              console.log(`    📊 Sending ${matchedPosts.length} post(s) (loose match)`);
              
              for (const post of matchedPosts) {
                const caption = `🔥 *${post.title}*\n\n` +
                  `🌐 *Source*: ${site.key}\n` +
                  `📥 [Watch Video](${post.videoUrl || post.url})`;
                
                try {
                  // Send to topic (or main chat if no thread_id)
                  const sendOptions = {
                    caption,
                    parse_mode: 'Markdown'
                  };
                  
                  if (topic.message_thread_id) {
                    sendOptions.message_thread_id = topic.message_thread_id;
                  }
                  
                  if (post.videoUrl) {
                    await bot.telegram.sendVideo(group.chatId, post.videoUrl, sendOptions);
                  } else if (post.thumbnail) {
                    await bot.telegram.sendPhoto(group.chatId, post.thumbnail, sendOptions);
                  } else {
                    await bot.telegram.sendMessage(group.chatId, caption, { parse_mode: 'Markdown' });
                  }
                  
                  console.log(`    ✅ Sent: ${post.title}`);
                  totalSent++;
                  
                  // Rate limit
                  await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                  console.error(`    ❌ Failed to send: ${err.message}`);
                  totalFailed++;
                }
              }
            }
          } else {
            // No forum topics - send to main chat
            console.log(`    📤 Sending to main chat (no forum topics)`);
            
            for (const post of posts.slice(0, 3)) {
              const caption = `🔥 *${post.title}*\n\n` +
                `🌐 *Source*: ${site.key}\n` +
                `📥 [Watch Video](${post.videoUrl || post.url})`;
              
              try {
                if (post.videoUrl) {
                  await bot.telegram.sendVideo(group.chatId, post.videoUrl, {
                    caption,
                    parse_mode: 'Markdown'
                  });
                } else if (post.thumbnail) {
                  await bot.telegram.sendPhoto(group.chatId, post.thumbnail, {
                    caption,
                    parse_mode: 'Markdown'
                  });
                } else {
                  await bot.telegram.sendMessage(group.chatId, caption, { parse_mode: 'Markdown' });
                }
                
                console.log(`    ✅ Sent: ${post.title}`);
                totalSent++;
                
                await new Promise(r => setTimeout(r, 1000));
              } catch (err) {
                console.error(`    ❌ Failed to send: ${err.message}`);
                totalFailed++;
              }
            }
          }
        } catch (err) {
          console.error(`    ❌ Error scraping ${site.key}: ${err.message}`);
        }
      }
    }
  }
  
  console.log(`\n\n🎉 Group send complete!`);
  console.log(`✅ Sent: ${totalSent}`);
  console.log(`❌ Failed: ${totalFailed}`);
  
  process.exit(0);
}

testGroupSend().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
