/**
 * api/digest.js
 * Vercel serverless function for the daily digest cron job.
 * Triggered by Vercel cron schedule defined in vercel.json.
 */
import { runDigest } from '../digest.js';

export default async function handler(req, res) {
  // Security: only allow Vercel cron calls (or GET for manual trigger)
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && req.method === 'POST' && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const channelId = process.env.DIGEST_CHANNEL_ID;
  if (!channelId) {
    return res.status(400).json({ error: 'DIGEST_CHANNEL_ID not configured' });
  }

  try {
    await runDigest(channelId);
    res.status(200).json({ ok: true, message: 'Digest sent successfully' });
  } catch (err) {
    console.error('Digest cron error:', err);
    res.status(500).json({ error: err.message });
  }
}
