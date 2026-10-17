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

## 3. Add the database: MongoDB Atlas

Atlas is MongoDB's own hosted service. The M0 tier is free with no time limit,
and because it lives outside Railway it survives a host change, a redeploy, or
moving the app somewhere else entirely.

### 3a. Create the cluster

1. **mongodb.com** → sign up → Atlas
2. Create a deployment → **M0** (the free one)
3. Provider **AWS**, region **us-east-1**

> Pick the region closest to where Railway runs your service. Railway shows it
> under Settings → Region. Every query crosses that gap, so a mismatched pair
> adds latency to every single request.

### 3b. Create a database user

Atlas prompts for this during cluster creation, or Database Access → Add New
Database User.

- Authentication: **Password**
- Privileges: **Read and write to any database**

⚠️ **Use an alphanumeric password.** Atlas will happily generate one
containing `@`, `/`, `#` or `?`, and every one of those characters has a
meaning inside a connection URI. A `@` in the password splits the URI at the
wrong place and you get an authentication error that looks like a wrong
password. If you keep a generated password, percent-encode it: `@` is `%40`,
`#` is `%23`, `/` is `%2F`, `:` is `%3A`.

### 3c. Open network access

Network Access → Add IP Address → **Allow access from anywhere**
(`0.0.0.0/0`).

This is required, not laziness. Railway does not give you a static outbound IP
on the hobby plan, so there is no single address to allowlist. The connection
is still authenticated and TLS encrypted, and M0 does not support private
networking. Treat the connection string as the credential it is.

### 3d. Build the connection string

Connect → **Drivers** → Node.js. You get:

```
mongodb+srv://wmuser:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

Two edits before it works:

```
mongodb+srv://wmuser:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/webmachine?retryWrites=true&w=majority
                     ^^^^^^^^^^^^^                                      ^^^^^^^^^^^
                     real password                                      database name
```

⚠️ **The database name is the edit people miss.** Atlas hands you the string
with nothing between the host and the `?`. Connect with it as-is and Mongoose
silently uses a database called `test`. Everything appears to work, and then
one day you look for your collections and they are in the wrong place. Insert
`/webmachine` before the `?`.

### 3e. Prove it works before Railway sees it

Put the string in your local `.env` and run:

```bash
npm run db:check
```

It parses the URI, names anything missing, then actually connects:

```
  database          webmachine
  connect           41 ms
  ping              22 ms
  collections       (none yet)

  Safe to paste this into Railway as MONGODB_URI.
```

If it fails it tells you which of the three things to go and change, rather
than handing you a driver stack trace. Twenty seconds here beats debugging a
silent Railway deploy.

### 3f. Put it in Railway

WebMachine service → Variables:

```
MONGODB_URI = mongodb+srv://wmuser:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/webmachine?retryWrites=true&w=majority
```

A literal value this time, not a Railway reference. Railway's own MongoDB
plugin is the one-click alternative and uses `${{MongoDB.MONGO_URL}}`, but it
bills against your plan and disappears with the project.

### What M0 gives you

512 MB of storage, shared CPU, 500 concurrent connections. The app opens a
pool of up to 20, set in `src/db/connect.js`.

Storage is the limit worth watching, because generated HTML lives in the
`sites` collection. A five-page build runs roughly 80 KB, since the stylesheet
is inlined into each page. That is about **6,000 builds** before M0 fills, and
the inlining is why: the CSS is stored five times per build rather than once.

That was the right trade for the buyer. A single `.html` opened straight out of
the download renders correctly, which removes an entire class of support
request. The cost is storage you have plenty of.

When it eventually matters, the fix is to prune the `files` array on old free
builds rather than to stop inlining.

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

(`npm run db:check` covers the database half of this locally, against the same
connection string Railway is using.)

```json
{ "ok": true, "db": "connected", "paused": false, "spendToday": 0 }
```

`db: connected` is the one that matters. If it says `disconnected`, work
through these in order, because they cover almost every case:

| Symptom in the Railway logs | Cause |
|---|---|
| `Authentication failed` | password wrong, or it contains a character that needs percent-encoding |
| `ECONNREFUSED` or a server-selection timeout | `0.0.0.0/0` is not in Atlas Network Access |
| Connects fine but collections are missing | no `/webmachine` in the URI, so you are writing to `test` |
| `querySrv ENOTFOUND` | the `mongodb+srv://` host is mistyped |

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
