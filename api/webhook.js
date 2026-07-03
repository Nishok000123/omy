import { bot } from '../core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('Bot webhook is active!');
    return;
  }

  try {
    // Process the incoming update from Telegram
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('Error handling webhook update:', err);
    res.status(500).send(err.toString());
  }
}
