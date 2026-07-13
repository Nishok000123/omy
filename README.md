# Omy — Telegram Feed & Digest Bot

Lightweight **Telegram bot** for multi-source media digests, scheduled delivery, and forum-topic routing.

Built with [Telegraf](https://github.com/telegraf/telegraf) + Node.js. Deploy on any host that supports Node (local polling, Render/Koyeb, or Vercel serverless + cron).

## Features

- 📬 **Daily digests** — opt-in schedule per user
- 🏷️ **Tag search** — quick filters + free-text search
- 📍 **Forum topics** — auto-route content by topic name
- 🔒 **Force-subscribe** — optional channel gate
- 💾 **Favorites** — save and revisit items
- ⏱️ **Auto-delete** — optional timed cleanup of media messages
- ☁️ **Serverless ready** — Vercel webhook + cron endpoints

## Stack

| Piece | Tech |
|--------|------|
| Bot framework | Telegraf 4 |
| HTTP / scrape helpers | axios, cheerio |
| Config | dotenv |
| Deploy | Vercel (`api/*` + crons) or long-running `node bot.js` |

## Quick start

```bash
git clone https://github.com/Nishok000123/omy.git
cd omy
npm install
cp .env.example .env   # then set BOT_TOKEN
npm start
```

### Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) |
| `PORT` | no | HTTP health port (default `3000`) |
| `CRON_SECRET` | no | Protect cron routes on Vercel |
| Blob / Edge config | no | Optional remote KV for multi-instance |

Create `.env`:

```env
BOT_TOKEN=123456:ABC-your-token
PORT=3000
```

## Commands (bot)

| Command | Who | Purpose |
|---------|-----|---------|
| `/start` | all | Main menu |
| `/forcechannel @name` | all | Set force-subscribe channel |
| `/setgroup` | all | Register current group |
| `/settopic Name` | all | Bind forum topic → tag name |
| `/groupinfo` | all | Group / forum diagnostics |
| `/topicinfo` | all | Current topic thread id |
| `/adduser` `/removeuser` | admin | Manage admins |
| `/broadcast` | admin | Message all digest users |

## Project layout

```
.
├── bot.js              # polling entry (local / VPS)
├── core.js             # Telegraf handlers & menus
├── scraper.js          # multi-source feed fetchers
├── kv-storage.js       # local / blob persistence
├── digest.js           # digest assembly
├── api/
│   ├── webhook.js      # Telegram webhook
│   ├── autosend.js     # daily digest cron
│   ├── groupsend.js    # forum topic cron
│   └── digest.js
├── vercel.json         # routes + cron schedule
└── package.json
```

## Deploy

### Local / VPS (polling)

```bash
npm start
```

### Vercel

1. Import the repo
2. Set `BOT_TOKEN` (and optional `CRON_SECRET`)
3. Point Telegram webhook at `/api/webhook`
4. Crons in `vercel.json` handle digests every day / every 6h

## Development

```bash
npm test                 # unit-style scraper/core checks
node test-groupsend.js   # manual group-topic dry run
```

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

This project is a **generic Telegram automation toolkit**. You are responsible for complying with Telegram’s Terms of Service, source site terms, and local laws when configuring sources and deploying.
