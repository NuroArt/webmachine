# WebMachine

A Telegram bot and Mini App that generates real multi-page websites and sales
funnels with Claude, paid for in Telegram Stars.

Built on the BBT backend architecture: Express, MongoDB, webhook-driven,
server-validated pricing, idempotent payments.

---

## What it sells

| Product | Price | What the buyer gets |
|---|---|---|
| **Free Homepage** | free, 1/day | 1 finished page |
| **Full Website** | **1,500 ⭐** (~$19) | Home, About, Services, Pricing, Contact, with working nav |
| **Sales Funnel** | **3,800 ⭐** (~$49) | landing, sales, checkout, upsell, thankyou |

**Stars only.** Telegram requires Stars for digital goods sold inside a bot, and
a non-Stars rail would hide the bot from every mobile user. There is no Stripe
path anywhere in this codebase.

---

## Layout

```
src/
├── index.js              boot, graceful shutdown
├── app.js                Express, helmet CSP, CORS, static Mini App
├── config/               env parsing with production assertions
├── catalog/products.js   THE PRICING SOURCE OF TRUTH
├── claude/
│   ├── client.js         one API entry point, spend breaker, extractors
│   ├── sitePrompts.js    THE PRODUCT: brief, page and CSS prompts
│   └── siteGenerator.js  3-stage orchestration, never throws for content
├── build/service.js      owners, invoices, builds, fulfilment, refunds
├── telegram/
│   ├── bot.js            Bot API wrapper, Stars invoices, refunds
│   └── auth.js           initData HMAC, webhook secret token
├── routes/
│   ├── webhook.js        ack-then-process, pre-checkout guard, bot intake
│   └── api.js            Mini App API + public capability URLs
├── models/               User, Site, Transaction
├── middleware/           tiered rate limits, error envelope
└── ui/                   formatters, error UI contract
public/index.html         the Mini App
scripts/                  check · test · test:e2e · set-webhook
```

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Fill in `.env`

| Variable | Where it comes from |
|---|---|
| `MONGODB_URI` | MongoDB Atlas M0, free. See `DEPLOY.md` step 3 |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET` | invent one: `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` | your deployed HTTPS URL |
| `MINI_APP_URL` | same as above (the app is served from `/`) |
| `OPS_CHANNEL_ID` | optional private channel for sale and failure alerts |

### 3. Verify before deploying

```bash
npm run db:check   # validates MONGODB_URI and actually connects
npm run check      # every module parses and its requires resolve
npm test           # 44 unit tests, no network, no database
npm run test:e2e   # 41 end-to-end tests against in-memory MongoDB
```

`npm run test:all` runs all three. **Nothing should be deployed on a red suite.**

### 4. Deploy, then register the webhook

```bash
npm start
npm run set-webhook          # points Telegram at PUBLIC_BASE_URL/webhook/telegram
npm run set-webhook -- --info
```

### 5. Point BotFather at the Mini App

`/mybots` → your bot → Bot Settings → Menu Button → set the URL to
`MINI_APP_URL`.

Telegram Stars needs no setup. There is no provider token and nothing to enable.

---

## How a build works

```
intake (bot or Mini App)
   ↓
STAGE 1  brief      one Claude call, returns JSON
         fixes the business positioning, palette, type and section plan
   ↓
STAGE 2  pages      one Claude call per page, ALL IN PARALLEL
         the shared brief is what keeps them consistent
   ↓
STAGE 3  css        one Claude call, LAST
         written against the class names that really appear in the markup
   ↓
assemble            CSS inlined into every page's <head>
   ↓
deliver             .zip in chat + live preview link
```

**Stage 3 must stay last.** Generating the stylesheet first produces selectors
for markup that was never written, which is how the previous version shipped
unstyled pages.

**Parallel pages** take a 5-page funnel from roughly four minutes to about
fifty seconds. Same cost, same output.

**CSS is inlined per page**, not linked to a shared `style.css`. A
non-technical buyer who opens a single `.html` without extracting the folder
still sees a styled page. `style.css` ships alongside for anyone who wants to
edit the design in one place, but no page depends on it.

---

## The money path

Five things protect it. None are optional.

**1. The catalog is the only price.** `handlePreCheckout` re-derives the
expected Star cost from `catalog/products.js` and rejects on mismatch. It also
checks the payer against the user id in the invoice payload. A tampered invoice
cannot underpay, and one account cannot pay another's invoice.

**2. `telegramChargeId` is unique.** A replayed webhook delivery hits the
index, is detected, and returns `duplicate` instead of building twice.

**3. The intake lives on the transaction.** A buyer may pay minutes later from
another device. The webhook that fulfils the payment is a different request
with no session to read from, so the answers are stored when the invoice is
created.

**4. Generation never throws for content reasons.** It returns
`{ ok: false, error }` so the caller can decide about a refund. A build that
fails after a successful payment must not lose the buyer's money.

**5. Failures refund automatically.** No one has to ask. An unanswered failure
becomes a chargeback, and chargebacks put the payment rail itself at risk.

---

## Preview and download URLs

`/p/<slug>/<file>` and `/d/<slug>.zip` are **capability URLs**: the unguessable
16-byte slug in the path is the credential, and neither route is initData
authenticated.

That is forced by two constraints. `Telegram.WebApp.openLink` hands the URL to
the system browser, which cannot carry the init-data header. And the generated
pages link to each other relatively, so a signed token in the query string
would be dropped the moment the visitor clicks through to the next page.

---

## Operational limits

| Guard | Default | Where |
|---|---|---|
| Free builds | 1 per 24h, rolling | `FREE_BUILDS_PER_DAY` |
| Build requests | 6 per 10 min per user | `middleware/rateLimit.js` |
| Writes | 40 per min per user | same |
| Reads | 120 per min per user | same |
| Daily Claude spend | $50, then builds pause | `DAILY_USD_CAP` |
| Concurrent builds | 1 per user, 10-min stale timeout | `claimBuildSlot` |

`GET /health` reports uptime, database state, today's spend and whether builds
are paused.

---

## Bot commands

```
/start    build a website or funnel (4-question intake)
/builds   your past builds with preview links
/pricing  what things cost
/invite   referral link
/refund   instant refund, no questions
/help     how this works
```

---

## Before taking a stranger's money

- [ ] `npm run test:all` green
- [ ] Buy your own Full Website **from Telegram Desktop**
- [ ] All five pages arrive, zip attaches, preview link renders
- [ ] `transactions` row shows `status: fulfilled` with a `telegramChargeId`
- [ ] `/refund` returns the Stars and flips the build to `refunded`
- [ ] Kill the process mid-payment, restart, confirm nothing double-delivers

The last one is the test that matters. The watchdog story only holds if you
have seen it hold.

---

## Changing the prompts

`src/claude/sitePrompts.js` is the product. Everything else is plumbing.

Two rules learned the hard way:

**Never demonstrate a character you forbid.** A prompt that uses an em-dash
while telling the model not to use one teaches it to use one.
`scripts/selfTest.js` asserts this about `BASE_SYSTEM`.

**Never trust a model with a character-level rule a regex enforces perfectly.**
`siteGenerator.scrubDashes` strips dashes deterministically after generation.
The prompt rule only reduces how often it has to.
