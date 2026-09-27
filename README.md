# INE Price Tracker: Backend

Tracks the price and stock of products in INE's mock store
(https://demo.inelabteamdev.com) on a fixed schedule, and keeps an honest log of every scrape attempt.

| | |
|---|---|
| **Live dashboard** | https://ine-tracker-price.vercel.app |
| **Live API** | https://ine-price-tracker-api-iwhp.onrender.com (`/api/health`) |
| **Frontend repo** | https://github.com/Mitanshi2034/frontend |
| **Design note** | [DESIGN_NOTE.md](DESIGN_NOTE.md) |

**Stack:** Node.js + Express 5 · Playwright (Chromium) · PostgreSQL on Supabase · Docker on Render · cron-job.org

## How it works

```
cron-job.org ──POST /api/cron/scrape (every 2 h, x-cron-secret)──▶ Express API (Render, Docker)
                                                                     │  ├─ catalog + search: plain HTTP + JSON
React dashboard (Vercel) ◀──── REST: search, track, history, CSV ────┤  └─ price + stock: Playwright (Chromium)
                                                                     ▼
                                                              Supabase Postgres
```

- **Catalog and search** use plain HTTP. The store's JSON endpoints are fetched politely (a 600ms gap,
  timeouts, retries with backoff) and all 960 products are kept in our database. The store has no search
  endpoint and shuffles its listing on every request.
- **Price and stock** use a real browser, because the store only reveals a price after browser checks:
  real mouse movement, WebAssembly and fingerprinting, and an encrypted response. The scraper handles the store's traps:
  - a random default option
  - silently dropped clicks
  - a cookie popup
  - hidden decoy prices
  - rotating class names
  - seven price formats
  - stale "Refreshing prices" quotes
  - slow or failing responses
- **Retries at four levels:** the store's own in-page retries, re-requesting stale quotes, up to 3 attempts per product
  in a fresh browser context, and a second pass after a 2-minute cool-down. When the store **rate-limits (HTTP 429)**, the
  scraper backs off 20s → 45s → 90s and pauses before the next product. Products are spaced 4s apart in every run.
- **Every scrape attempt is stored** as `success`, `retried` or `failed`. A failed attempt stores no price or stock.
  The database enforces this with CHECK constraints, so wrong or empty data cannot be saved.

## Scraping schedule

| What | When |
|---|---|
| Scheduled scrape | **Every 2 hours at minute 13** (crontab `13 */2 * * *`, Asia/Kolkata: 00:13, 02:13, … 22:13), triggered by **cron-job.org** calling `POST /api/cron/scrape` with the `x-cron-secret` header. Minute 13 rather than 0 avoids the top-of-the-hour burst of other scrapers that got us rate-limited |
| Which products | Every active tracked product whose interval (default 120 min, configurable per product: 2 h … daily) has passed, with a 15-minute tolerance |
| Keep-warm | cron-job.org calls `GET /api/health` every 10 minutes, so Render's free instance doesn't sleep |
| First scrape | Starts immediately when a product is tracked, and on demand with "Check now" |
| Catalog refresh | On server start, if the catalog is empty or older than 24 h |

Why an external scheduler: Render's free tier sleeps when idle, so an in-process timer would stop. The cron
endpoint replies `202` immediately and scrapes in the background (one browser, one product at a time).
Only one run can be active at a time, because a unique index enforces it.

## Bonus features

| Bonus from the brief | Where |
|---|---|
| Price-drop / back-in-stock alerts (in-app) | **Alerts** panel on the dashboard and on each product page: price drop, price up, back in stock, sold out (`GET /api/changes`) |
| Change detection for the store's page structure | The layout variant is recorded on every check, and **"Store layout changed"** alerts fire when it switches. Checks that fail because the page no longer looks as expected are flagged as **"Page structure changed"** |
| Configurable scrape frequency per product | Product page ⋯ menu: every 2 / 4 / 6 / 12 hours or daily (`PATCH /api/tracked/:id`) |
| Dashboard across multiple products + extra info | Overview cards (change since last check, trend line, stock), and per product: MRP, lowest/average/highest, seller, rating, delivery |

## Setup (local)

**Requirements:** Node.js 20+, a Supabase project (free), Playwright's Chromium.

```bash
git clone https://github.com/Mitanshi2034/backend.git
cd backend
npm install
npx playwright install chromium
cp .env.example .env          # fill in DATABASE_URL and CRON_SECRET (see below)
npm run db:migrate            # creates the tables (or paste src/db/schema.sql into Supabase > SQL Editor)
npm run catalog:sync          # optional: collect the store catalog now (~1 min); otherwise it runs on start
npm run dev                   # http://localhost:4000
```

Then run the [frontend](https://github.com/Mitanshi2034/frontend) with `VITE_API_URL=http://localhost:4000`.

### Commands
| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Start the API (dev: auto-restart on changes) |
| `npm run db:migrate` | Create or upgrade the database schema (safe to re-run) |
| `npm run catalog:sync` | Collect all store products into `catalog_products` |
| `npm run scrape:headed` | **Headed mode**: watch the scraper in a visible browser (see below) |
| `npm test` | Price/stock parser tests (run against the store's own formatting code) |

### Headed mode (watch the scraper)
```bash
npm run scrape:headed                                        # all tracked products, visible browser, nothing saved
npm run scrape:headed -- --product 2565 --option o2          # one product option
npm run scrape:headed -- --product 2565 --option o2 --chaos  # + simulated slow and failing responses
npm run scrape:headed -- --save                              # a real run, saved with trigger "cli"
npm run scrape:headed -- --slow 250                          # slow every action down (default 120 ms)
```
A status banner on the store page and timestamped terminal output show each step. `--chaos` uses
network interception to fail the layout request on attempt 1, delay a response by 5s, and return two 503s, so
the retry logic can be seen. Chaos results are never saved.

## Environment variables

| Variable | Required | Example | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` | Supabase **Session pooler** connection string (IPv4, needed for Render) |
| `CRON_SECRET` | yes | output of `openssl rand -hex 32` | Shared secret. cron-job.org sends it in the `x-cron-secret` header |
| `CORS_ORIGIN` | yes (prod) | `https://ine-tracker-price.vercel.app,http://localhost:5173` | Frontend origins allowed to call the API |
| `PORT` | no | `4000` | Render sets this automatically |
| `DATABASE_SSL` | no | `true` | Keep `true` for Supabase |
| `STORE_BASE_URL` | no | `https://demo.inelabteamdev.com` | The mock store |
| `HEADLESS` | no | `true` | `false` shows the browser window |

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | API + database status |
| GET | `/api/catalog/search?q=` | – | Partial/full name search (every word must match, any order) |
| GET | `/api/catalog/products/:id` | – | Live product details + options |
| POST | `/api/catalog/sync` | secret | Start a catalog sync |
| GET | `/api/tracked` | – | Tracked products with latest price/stock/outcome and stats |
| POST | `/api/tracked` | – | `{store_product_id, option_id}`: track + first scrape |
| PATCH | `/api/tracked/:id` | – | `{scrape_interval_minutes, is_active}` |
| DELETE | `/api/tracked/:id` | – | Stop tracking (deletes its history) |
| GET | `/api/tracked/:id/history` | – | Every scrape attempt (log + chart data) |
| POST | `/api/tracked/:id/scrape` | – | Check now |
| GET | `/api/runs` | – | Recent runs (scheduled / manual / CLI) |
| GET | `/api/attempts` | – | Every scrape attempt across products (`?outcome=`, `?tracked_id=`) |
| GET | `/api/changes` | – | Alerts: price drop/up, back in stock, sold out, layout/structure changes |
| GET | `/api/stats` | – | Totals for the dashboard (checks in the last 24 h, success rate, scheduled runs) |
| GET | `/api/export/scrapes.csv` | – | CSV of every attempt (see below) |
| POST | `/api/cron/scrape` | secret | Scheduled run (cron-job.org) |

**CSV export:** one row per scrape attempt, oldest first. Columns:
`store_product_id, product_name, selected_option, timestamp (ISO 8601, UTC), price, stock, outcome`.
Failed attempts are included with empty price and stock.

## Deployment

- **Database:** Supabase (free). Run `src/db/schema.sql` once.
- **Backend:** Render Web Service (free), **Docker** runtime using the included `Dockerfile` (official Playwright image,
  so Chromium and its libraries are present). `render.yaml` describes the service. Health check: `/api/health`.
- **Frontend:** Vercel (see the frontend repo). Set `CORS_ORIGIN` here to its URL.
- **Scheduler:** cron-job.org: `POST /api/cron/scrape` on `13 */2 * * *` with header `x-cron-secret`, plus
  `GET /api/health` every 10 minutes (keep-warm).

## Project layout

```
src/
  index.js            Express app, routes, graceful shutdown
  config.js           all environment variables
  db/schema.sql       tables + guardrail constraints
  scraper/http.js     polite HTTP client (gap, timeout, retry, validation)
  scraper/catalog.js  catalog sync, search, product details
  scraper/price.js    Playwright price/stock scraper
  scraper/parse.js    strict price/stock parsing
  scraper/runner.js   scrape runs: selection, one row per product, crash recovery
  routes/             health, catalog, tracked, runs, export, cron, insights (attempts, changes, stats)
scripts/              migrate, sync-catalog, scrape-headed
test/                 parser tests
```
