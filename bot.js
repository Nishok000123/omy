import { bot } from './core.js';
import http from 'http';

// Create dummy HTTP server for Koyeb/Render port-binding checks
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Start the bot using polling (for local dev / non-serverless hostings)
bot.launch()
  .then(() => {
    console.log('Omy feed bot running (polling mode)');
  })
  .catch((err) => {
    console.error('Failed to launch bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
