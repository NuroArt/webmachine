# Deploying WebMachine

GitHub holds the code, GitHub Actions gates it, Railway runs it. Every push to
`main` that passes CI redeploys automatically.

---

## 1. Push the code

```bash
git remote add origin git@github.com:NuroArt/webmachine.git
git push -u origin main
```

CI runs on that first push. Let it go green before touching Railway.

---

## 2. Create the Railway project

1. **railway.com** → New Project → **Deploy from GitHub repo**
2. Pick `NuroArt/webmachine`
3. Railway reads `railway.json`, sees `builder: DOCKERFILE`, and builds the
   `Dockerfile`

The first deploy will boot and pass its health check even with nothing
configured yet, because `/health` does not require Claude or Telegram. It just
cannot build anything.

---

## 3. Add the database

**Option A, one click:** in the project, **+ New** → **Database** → **MongoDB**.

Then on the WebMachine service, Variables → add:

```
MONGODB_URI = ${{MongoDB.MONGO_URL}}
```

That is a Railway variable reference, not a literal. Check the Mongo service's
own Variables tab for the exact name it exposes and match it. Railway injects
the real value at deploy time and rotates it with the database.

**Option B, free forever:** a MongoDB Atlas M0 cluster. Five minutes of setup
(create cluster, add a database user, allow `0.0.0.0/0` in Network Access) and
it costs nothing and survives any host migration. Paste its connection string
into `MONGODB_URI` directly.

Atlas is the better long-term home. Railway Mongo is the faster start.

---

## 4. Set the rest of the variables

On the WebMachine service → Variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `PRICE_SITE_STARS` | `1500` |
| `PRICE_FUNNEL_STARS` | `3800` |
| `OPS_CHANNEL_ID` | optional, your private alert channel |

Leave `PORT` alone. Railway sets it and `config/index.js` reads it.

> `NODE_ENV=production` turns on the config assertions in
> `src/config/index.js`. A missing key fails the boot loudly instead of
> producing a bot that silently cannot generate anything.

---

## 5. Get the domain, then feed it back

Settings → Networking → **Generate Domain**. You get something like
`webmachine-production.up.railway.app`.

Add two more variables using it:

```
PUBLIC_BASE_URL = https://webmachine-production.up.railway.app
MINI_APP_URL    = https://webmachine-production.up.railway.app
CORS_ORIGINS    = https://webmachine-production.up.railway.app
```

This is the one ordering trap in the whole setup: the app needs its own public
URL to write preview and download links, and Railway only issues that URL
after the first deploy. Set them, let it redeploy, then continue.

---

## 6. Register the webhook

From your machine, with `.env` pointing at the deployed URL:

```bash
npm run set-webhook
npm run set-webhook -- --info
```

`--info` should show your Railway URL and `pending_update_count: 0`.

---

## 7. Point BotFather at the Mini App

`/mybots` → your bot → Bot Settings → Menu Button → paste `MINI_APP_URL`.

Telegram Stars needs no setup: no provider token, nothing to enable.

---

## 8. Verify

```bash
curl https://your-domain.up.railway.app/health
```

```json
{ "ok": true, "db": "connected", "paused": false, "spendToday": 0 }
```

`db: connected` is the one that matters. If it says `disconnected`, the
`MONGODB_URI` reference is wrong.

---

## Keep it at one replica

`railway.json` pins `numReplicas: 1` deliberately.

The daily spend breaker and the rate limiters live in process memory. Two
replicas would give you two independent $50 caps and halve the effectiveness
of every rate limit, while a user's build slot would only be enforced on
whichever instance they happened to hit.

Scaling past one replica means moving those three things to MongoDB or Redis
first. Until then, one replica is the correct configuration, not a limitation.

---

## Rollback

Railway keeps every deploy. Deployments tab → pick the last good one →
**Redeploy**. Nothing to rebuild and nothing to revert in git.

---

## What CI does and does not cover

CI runs the full ladder: module loading, 44 unit tests, 41 end-to-end tests
against an in-memory MongoDB with Claude and the Telegram API stubbed.

It does not spend a cent and it never touches real Telegram. So it proves the
plumbing and cannot prove the money path. That still takes one real purchase
from Telegram Desktop, and the checklist for it is at the end of `README.md`.
