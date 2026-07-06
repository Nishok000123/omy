import { bot } from '../core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('Bot webhook is active!');
    return;
  }

  try {
    // CRITICAL: Respond to Telegram IMMEDIATELY to avoid timeout (Vercel has 10s limit)
    // Then process the update asynchronously in the background
    res.status(200).send('OK');

    // Process update asynchronously (fire-and-forget)
    // This allows scraping operations (which take 5-30s) to complete without blocking
    bot.handleUpdate(req.body).catch(err => {
      console.error('Error handling webhook update:', err);
    });
  } catch (err) {
    console.error('Error in webhook handler:', err);
    // Already sent 200 OK, so this won't affect Telegram
  }
}
