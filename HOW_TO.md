# HOW_TO — INE Product Price Tracker

> This is our working handbook. It explains **what** we are building, **what we found out** about the
> store, **why** we made each decision, **how** to run everything, and **what to say** when someone asks.
> It is updated at the end of every step.

**Deadline:** Sunday 27 September 2026, 11:59 PM IST. Submit at https://forms.gle/6LGyJV9yi6W1gna18

---

## Contents
1. [The assignment in one minute](#1-the-assignment-in-one-minute)
2. [Architecture](#2-architecture)
3. [Tech stack and why](#3-tech-stack-and-why)
4. [Project structure](#4-project-structure)
5. [Step 0: what we found out about the store](#5-step-0-what-we-found-out-about-the-store)
6. [Key decisions and trade-offs](#6-key-decisions-and-trade-offs)
7. [The database explained](#7-the-database-explained)
8. [Step 1: how the project was created](#8-step-1-how-the-project-was-created)
   - [Step 2: catalog sync and search](#8b-step-2-catalog-sync-and-search)
9. [Running the project locally](#9-running-the-project-locally)
10. [Environment variables](#10-environment-variables)
11. [Progress tracker](#11-progress-tracker)
12. [AI usage log (for the design note)](#12-ai-usage-log-for-the-design-note)
13. [Interview preparation: likely questions](#13-interview-preparation-likely-questions)
14. [Glossary](#14-glossary)

---

## 1. The assignment in one minute

We build a small full-stack web app on top of INE's mock store (https://demo.inelabteamdev.com):

1. **Search** the store by partial or full product name and **pick a product + one option**
   (e.g. "Standard kit", "512 GB"). Each option has its own price.
2. **Track** it. The app scrapes its **price and stock every 2 hours** without anyone watching.
3. Show **price and stock history** as a chart or table.
4. Show a **scrape log** per product, with every attempt marked `success`, `retried` or `failed`.
5. **Export** the full scrape history to CSV.
6. Run the scraper in **headed mode** (a visible browser) and record a 2–4 minute video of it.

**The real test is the scraper**, not the UI. The store is deliberately hard to scrape, and the grading
focuses on: *keeps working over many unattended runs, never stores wrong or empty data, and logs
failures honestly.*

Required hosting: **Vercel** (frontend), **Render** (backend), **Supabase** (database),
**cron-job.org** (scheduler). Free tiers only.

---

## 2. Architecture

```
                         every 2 hours
   ┌──────────────┐   POST /api/cron/scrape    ┌────────────────────────────────────────┐
   │ cron-job.org │ ─────────────────────────▶ │  Backend: Node.js + Express (Render)   │
   └──────────────┘   (x-cron-secret header)   │                                        │
                                               │  ┌──────────────┐   ┌───────────────┐  │
   ┌──────────────┐   REST API (JSON / CSV)    │  │ API routes   │   │ Scraper       │  │
   │  Browser     │ ◀────────────────────────▶ │  │ search,track │   │ HTTP: catalog │  │
   │  React app   │                            │  │ history, CSV │   │ Playwright:   │  │
   │  (Vercel)    │                            │  └──────┬───────┘   │ price + stock │  │
   └──────────────┘                            │         │           └──────┬────────┘  │
                                               └─────────┼──────────────────┼───────────┘
                                                         │ SQL (pg)         │ HTTPS
                                                         ▼                  ▼
                                               ┌──────────────────┐  ┌──────────────────────┐
                                               │ Supabase Postgres│  │ INE mock store       │
                                               │ tracked products │  │ demo.inelabteamdev   │
                                               │ scrape attempts  │  │ .com                 │
                                               └──────────────────┘  └──────────────────────┘
```

**Flow of one scheduled scrape (planned, Step 3):**
1. cron-job.org calls `POST /api/cron/scrape` with a secret header.
2. The backend checks the secret, creates a `scrape_runs` row (this also stops two runs from overlapping),
   and **replies immediately** with `202 Accepted`. cron-job.org cuts off requests after about 30 seconds,
   and one price scrape takes 8–12 seconds.
3. In the background, for each tracked product **one at a time**: open the page in Playwright → pick the
   option → pass the interaction gate → read the real price and stock → validate → retry if needed.
4. Every product produces exactly **one** `scrape_attempts` row: `success`, `retried` or `failed`.
5. The run row is closed with counts (succeeded/failed).

**Why an external cron?** Render's free tier **puts the server to sleep** after about 15 minutes with no
traffic. A timer inside the server (`setInterval`, `node-cron`) would stop when it sleeps. An outside
service calling us wakes the server up, so the schedule always fires.

---

## 3. Tech stack and why

| Part | Choice | Why |
|---|---|---|
| Frontend | **React 19 + Vite 8** (JavaScript) | Required (React or Vue). Vite gives a ready project structure and a fast dev server. |
| Charts | **Recharts** | Simple React chart library for price/stock over time. |
| Backend | **Node.js + Express 5** | Required (Express or Django). Same language as the frontend and as Playwright. Express 5 passes errors from `async` routes to the error handler automatically. |
| Database driver | **pg** (node-postgres) | Talks to Supabase as a normal Postgres database. Nothing Supabase-specific, and it works with any Postgres. |
| Database | **Supabase (PostgreSQL)** | Required. Real SQL with constraints we use as safety checks. |
| Catalog scraping | **Built-in `fetch`** | The catalog and product details are plain JSON endpoints, so no browser is needed. Lightweight, as the assignment prefers. |
| Price scraping | **Playwright 1.63 (Chromium)** | The price only appears after browser checks (WASM, fingerprinting, real mouse movement, encrypted response). It needs a real browser. It also gives us **headed mode** for the recording. |
| Scheduler | **cron-job.org** | Required approach for sleeping free-tier backends. |
| Hosting | **Vercel / Render** | Required. |

---

## 4. Project structure

The project is split into **two GitHub repositories**:

| Repo | Contents | Deployed to |
|---|---|---|
| **backend**: https://github.com/Mitanshi2034/backend | Express API, scraper, database schema, **this handbook**, docs | Render |
| **frontend**: https://github.com/Mitanshi2034/frontend | React dashboard | Vercel |

Locally they sit side by side in one folder (`mitu_project/backend` and `mitu_project/frontend`).

**backend repo**
```
backend/
├── HOW_TO.md                 ← this handbook
├── README.md                 ← (Step 6) short setup guide required by the assignment
├── DESIGN_NOTE.md            ← (Step 6) reliability, trade-offs, AI usage
├── docs/
│   └── STORE_RECON.md        ← raw technical notes from inspecting the store
├── .gitignore                ← keeps node_modules and .env (secrets) out of Git
├── package.json              ← dependencies and scripts (start, dev, db:migrate, catalog:sync)
├── .env.example              ← template of every environment variable (copy to .env)
├── scripts/
│   ├── migrate.js            ← runs schema.sql against the database
│   └── sync-catalog.js       ← (Step 2) collect all 960 products now, with progress output
└── src/
    ├── index.js              ← creates the Express app: CORS, JSON, routes, error handler;
    │                           on startup, syncs the catalog if it's empty or older than 24 h
    ├── config.js             ← reads ALL environment variables in one place
    ├── db/
    │   ├── pool.js           ← one shared Postgres connection pool
    │   └── schema.sql        ← all tables and the safety rules (constraints)
    ├── middleware/
    │   └── requireSecret.js  ← (Step 2) checks the x-cron-secret header on "start work" endpoints
    ├── scraper/
    │   ├── http.js           ← (Step 2) polite HTTP client: gap between requests, timeout, retry+backoff, validation
    │   └── catalog.js        ← (Step 2) catalog sync algorithm, search, product details
    └── routes/
        ├── health.js         ← GET /api/health: is the API up, is the DB reachable?
        └── catalog.js        ← (Step 2) /api/catalog/search, /status, /sync, /products/:id
```

**frontend repo**
```
frontend/
├── README.md                 ← short intro, links back to this handbook
├── index.html                ← page shell; <title>INE Price Tracker</title>
├── vite.config.js
├── .env.example              ← VITE_API_URL template
└── src/
    ├── main.jsx              ← mounts <App /> into the page
    ├── App.jsx               ← (Step 1) placeholder showing API + DB status
    ├── api.js                ← every call to the backend goes through here
    └── index.css             ← base styles and colour variables
```

Coming in later steps: `src/scraper/price.js` (Playwright price scraper + parsers),
`src/routes/{tracked,export,cron}.js`, `scripts/scrape-headed.js`, `Dockerfile` (backend),
and the dashboard components (frontend).

---

## 5. Step 0: what we found out about the store

> Full technical notes: [docs/STORE_RECON.md](docs/STORE_RECON.md). This section is the explained version.

### 5.1 How we investigated (the method)
1. **Downloaded the homepage HTML.** It was almost empty: just `<div id="root">` and a script tag. So the site
   is a **single-page app (SPA)**. JavaScript builds everything in the browser, and plain HTML parsing
   of the page would find nothing.
2. **Downloaded and read the JavaScript bundle** (`/assets/index-*.js`, about 288 KB). We searched it for
   `fetch(` and `/api/` to find which endpoints it calls.
3. **Decoded the obfuscated part.** The price code hides its strings in an encoded table. We ran the
   store's own decoder function in Node to reveal the strings (e.g. `/api/v2/handshake`, `/quote?opt=`,
   `Bearer`).
4. **Probed each endpoint** with `curl` and small Node scripts, measuring status codes and response times.
5. **Ran a real browser (Playwright)** against product pages 11 times to confirm the price flow and to
   see every trap in action.

### 5.2 The easy part: open JSON endpoints
| Endpoint | What it returns |
|---|---|
| `GET /api/v2/listings?page=N&limit=60` | Catalog page: 960 products in total, **at most 60 per page** |
| `GET /api/v2/items/:id` | Name, brand, category, SKU, specs, reviews, **options** (`o1`, `o2`, … with labels). **No price.** |
| `GET /api/v2/ui/manifest` | The page's current CSS class names and layout. These **rotate over time**. |

The product ID the assignment asks for in the CSV is the number in the product page URL: `/item/2565` → `2565`.

### 5.3 Catalog traps
| Trap | Evidence | Our answer |
|---|---|---|
| **No search endpoint** | `?q=`, `?search=` and `?name=` are all ignored and return all 960 products | Copy the whole catalog into our DB (`catalog_products`) and search it with SQL |
| **Listing is reshuffled on every request** | Going through pages 1–16 once gave only **621 of 960** unique products | Keep fetching pages until we have collected all 960 unique IDs (the total `count` tells us when we're done) |
| **Rate limiting** | 25 parallel requests → mostly **503** from nginx. Sequential with a ~0.7s gap → **100% success** | The scraper sends **one request at a time**, with pauses and retries |

### 5.4 The hard part: the price needs a real browser
The price is **not** in any open endpoint. When a human clicks "Check today's price":
1. The page first requires **real mouse movement** over the price box: at least 8 moves and 0.6 seconds of
   hovering. Until then the button stays disabled ("Hover over the price area to load the current price").
2. `GET /api/v2/handshake` → the server sends a **salt**, a **difficulty** and a small **WebAssembly** program.
3. The browser collects a **fingerprint** (canvas drawing hash, WebGL graphics card info, animation-frame
   timings, screen size, CPU cores), runs the WASM, and solves a **proof-of-work** puzzle: it finds a number
   whose SHA-256 hash starts with N zeros.
4. `POST /api/v2/handshake` with all that → the server returns a one-time **pass token**
   (or **429** if we're rate-limited).
5. `GET /api/v2/items/:id/quote?opt=o2` with `Authorization: Bearer <pass>` → an **encrypted** blob.
   The browser decrypts it (XOR with a SHA-256-derived key) into the real quote: price, MRP, member price,
   stock, rating, seller, delivery days, and a `pending` flag.
   Without the token the server answers `401 unauthorized`.

**Conclusion:** we *could* try to rebuild all of this in plain Node, but it would mean faking canvas, WebGL,
frame timings and mouse data, and copying a hidden secret out of their code. It would break the moment they
change their bundle. **A real browser does all of it naturally**, so we use Playwright **only for this
step**.

### 5.5 Traps on the product page (and how the scraper beats each one)
| # | Trap | What happens | How we handle it |
|---|---|---|---|
| 1 | **Random default option** | Every page load pre-selects a random option (kit, storage, …) | Click the option we track, then **check** it shows `aria-pressed="true"` before reading the price |
| 2 | **Dropped clicks** | 35% of clicks are tampered with: half are silently ignored and half are delayed by 0.9s | After clicking, wait 1.5s. If the panel is still "locked", click again |
| 3 | **Cookie popup** | Appears 1.5–5s after load (75% of visits) at a random position, blocks the page, and may need **1–3** clicks | Dismiss it in a loop until it's gone, and check again before each click |
| 4 | **Interaction gate** | The button is disabled until there's enough real mouse movement | Move the mouse across the price box in many small steps, then wait more than 600ms |
| 5 | **Decoy prices** | Two hidden elements, `span.price-value` and `span.amount[data-price]`, hold **fake** prices | Never use those. Read only the element with the manifest's `priceValue` class |
| 6 | **Look-alike prices** | Struck-through MRP and a "Member price …" sit next to the real price | Same as above: target the real price element only |
| 7 | **Rotating layout** | Class names, element order, tag name and "split" mode change over time | Fetch the manifest on every scrape and build our selectors from it |
| 8 | **7 price formats** | `₹1,45,800` · `1 45 800` · `1.45.800,00` · `…/- (incl. of all taxes)` · full-width digits `１２３` · characters separated by invisible spaces · `Rs. 1,45,800.00` | One normaliser: strip invisible characters, convert full-width digits, detect the decimal style, parse to a number, and **check it's sensible** |
| 9 | **Stale "Refreshing prices" state** | The quote is marked `pending`: dimmed price with "Refreshing prices" | Treat it as **not ready**. Wait and retry, and **never store it** |
| 10 | **5 stock phrasings** | "N units available", "Last few: N", "Available (N)", "Stock: N remaining", "Ready to ship · N available", or "Sold out" | Extract the number with patterns. "Sold out" means 0 |
| 11 | **Store-side failures** | Upstream errors, "Retrying (attempt n/6)…", and finally "Couldn't load the price after N attempts" | Our own retry with backoff, then an honest `failed` row |

### 5.6 What a real scrape looked like (measured)
- 11 of 11 Playwright scrapes succeeded. Each took **8–12 seconds** (mostly waiting for the popup and the gate).
- In 2 of 11 runs the **first click was dropped**. Detecting it and clicking again worked.
- Example: product **2565**, "Standard kit" → price **₹22,950**, stock **36** ("Last few: 36").
  In the same page the hidden decoys said ₹18,112 and ₹21,158. That's exactly the wrong data we must avoid.

---

## 6. Key decisions and trade-offs

1. **Hybrid scraping: HTTP where possible, a browser only where needed.**
   Catalog, search and product details use plain `fetch`: fast, light, reliable. Only the price and stock use
   Playwright, because the page genuinely requires JavaScript. *Trade-off:* a browser is heavier (memory,
   about 10 seconds per product), but it's the only robust way through the challenge.

2. **One table for both history and log** (`scrape_attempts`).
   The price history is simply the successful rows. The chart and the log can never disagree, and
   failures cannot be "lost" between two tables.

3. **Safety rules inside the database, not only in code.**
   CHECK constraints make it **impossible** to save a failed attempt with a price, or a "success" with an
   empty or zero price. Even a scraper bug cannot write wrong data (see section 7).

4. **Honest outcome labels.** `success` = first try worked. `retried` = worked after retries. `failed` =
   gave up, with no data stored. The database checks the label matches the number of tries.

5. **Respond-then-work cron endpoint.** Reply `202` straight away and scrape in the background, because
   cron-job.org times out after about 30 seconds.

6. **No overlapping runs.** A unique index allows only one `running` row in `scrape_runs`. If a second cron
   call arrives mid-run, it's skipped instead of launching a second browser (which could crash a 512 MB
   free server).

7. **Sequential, polite scraping.** One browser, one product at a time, with pauses, because the store rate-limits.

8. **Plain `pg` instead of the Supabase JS client.** The backend is the only thing that touches the database.
   This keeps it standard Postgres and portable.

9. **Supabase REST API locked.** Row Level Security is enabled with no policies, so the only way to the data
   is through our Express API.

---

## 7. The database explained

File: [src/db/schema.sql](src/db/schema.sql). It's safe to run more than once.

| Table | One row = | Key columns |
|---|---|---|
| `catalog_products` | a product in the store | `store_product_id` (from `/item/:id`), name, brand, category, sku |
| `tracked_products` | a product **+ option** the user tracks | `store_product_id`, `option_id` (`o2`), `option_label` ("Standard kit"), `scrape_interval_minutes` (default 120), `is_active`, `last_scraped_at`. Unique on (product, option). |
| `scrape_runs` | one trigger (cron / manual / cli) | `status` (running/completed/failed/abandoned), counts, timestamps |
| `scrape_attempts` | one product scraped in one run | `attempted_at`, `outcome`, `price`, `stock`, `mrp`, `attempts`, `error`, `raw_price_text`, `layout_variant`, `duration_ms` |

**The guardrails (CHECK constraints)** on `scrape_attempts`:
```sql
-- failed  → price and stock MUST be empty
-- success / retried → price MUST be > 0 and stock MUST be >= 0
(outcome = 'failed' AND price IS NULL AND stock IS NULL)
OR (outcome IN ('success','retried') AND price > 0 AND stock >= 0)

-- labels must be honest
(outcome = 'success' AND attempts = 1) OR (outcome = 'retried' AND attempts > 1) OR outcome = 'failed'
```

**Tested (17 of 17 passed)** on a real Postgres engine (PGlite):
- accepted: success on first try, retried after 3 tries, failed with no data, sold out (stock 0)
- rejected: failed-with-price, success with NULL/0 price, NULL or negative stock, "success" after 2 tries,
  "retried" with 1 try, unknown outcome, two runs at once, duplicate product+option
- deleting a tracked product also deletes its attempts (cascade)
- the schema can be applied twice without errors (idempotent)

**CSV export mapping (planned, Step 3):**

| CSV column | Comes from |
|---|---|
| store product ID | `tracked_products.store_product_id` |
| product name | `tracked_products.name` |
| selected option | `tracked_products.option_label` |
| timestamp (ISO 8601, UTC) | `scrape_attempts.attempted_at` → e.g. `2026-09-26T14:00:03.512Z` |
| price | `scrape_attempts.price` (empty when failed) |
| stock | `scrape_attempts.stock` (empty when failed) |
| outcome | `scrape_attempts.outcome` |

---

## 8. Step 1: how the project was created

These are the exact commands, so you can explain or repeat them.

**Frontend**
```bash
npm create vite@latest frontend -- --template react --no-interactive   # React + JS template
cd frontend
npm install
npm install recharts                                                   # charts
```
Then we removed the template demo (logo, counter, `App.css`), set the page title, and added
`src/api.js` (backend client) and a placeholder `App.jsx` that shows API and database status.

**Backend**
```bash
mkdir backend && cd backend
# package.json written by hand: "type": "module" (use import/export), scripts start/dev/db:migrate
npm install express@5 cors pg dotenv playwright@1.63.0
```
Playwright is pinned to an **exact** version so the Docker image we deploy with (`mcr.microsoft.com/playwright:v1.63.0`) has
the matching browser.

**What each backend dependency does**
| Package | Purpose |
|---|---|
| `express` | Web server and routing |
| `cors` | Lets our Vercel frontend call the Render API from the browser |
| `pg` | Postgres client (connection pool, parameterised queries) |
| `dotenv` | Loads `backend/.env` into `process.env` when running locally |
| `playwright` | Controls Chromium for the price scrape and headed mode |

**Verified in Step 1:**
- The migration creates all 4 tables.
- `GET /api/health` → `{"status":"ok","database":"ok"}`.
- CORS: `http://localhost:5173` is allowed, and other origins get no CORS headers (the browser blocks them).
- The frontend builds with Vite and, in the browser, shows **"API: ok · Database: ok"** end-to-end.

---

## 8b. Step 2: catalog sync and search

**Goal:** let the user search the store by partial or full product name, then see the options they can track.
Everything in this step is **plain HTTP** (no browser), as the assignment prefers.

### 8b.1 More findings (measured before writing code)
- Parameters like `sort=id`, `order=asc`, `seed=1`, `shuffle=false` and `sort=name` are **all ignored**. Every listing
  request is a fresh random sample.
- Collecting by sampling alone took **142 requests**. The last few products are the slowest to find (921 → 960
  took about 90 requests). This is the classic "coupon collector" problem.
- Sending a request every ~350ms caused **24 × `429 Too Many Requests`**.
- Product IDs are exactly **2001–2960** (960 IDs for 960 products).

### 8b.2 The polite HTTP client ([src/scraper/http.js](src/scraper/http.js))
Every plain request to the store goes through one function, `fetchStoreJson(path, options)`:

| Feature | How | Why |
|---|---|---|
| **Politeness** | At least **600ms** between request starts across the whole server (a shared "next free slot") | 350ms triggered 429s. 600ms has been accepted every time |
| **Timeout** | Each request is aborted after 15s (`AbortSignal.timeout`) | A hanging request must never block the scraper forever |
| **Retries** | Up to 4 attempts on network errors, timeouts, `408/425/429/5xx`, invalid JSON, or wrong shape | These are usually temporary |
| **Backoff** | Waits 0.8s → 1.6s → 3.2s … (+ random jitter), or the server's `Retry-After` | Don't hammer a struggling server. Jitter avoids synchronised retries |
| **Global cool-down** | After a 429/503, **all** callers pause, not just the one that failed | The rate limit applies to the whole server, not one request |
| **No pointless retries** | `404` and other 4xx fail immediately | Retrying "not found" can't help |
| **Validation** | The caller passes `validate(data)`. Wrong shape → error (retried) | Never use data that doesn't look like what we expect |
| **Honest error info** | Errors carry `kind` (http/timeout/network/shape), `status` and the real `attempts` count | Needed later for an honest scrape log |

**Tested against a fake misbehaving store (7 of 7 correct):**

| Scenario | Result |
|---|---|
| 503, 503, then OK | ✅ succeeded on attempt 3 |
| 429 with `Retry-After: 1` | ✅ waited 1s, succeeded on attempt 2 |
| First request hangs | ✅ timed out after 1s, succeeded on attempt 2 |
| 404 | ✅ gave up after **1** attempt (not retried) |
| HTML page instead of JSON | ✅ detected as `shape` error, gave up after its attempts |
| Wrong JSON shape, then correct | ✅ succeeded on attempt 2 |
| Store completely down (always 503) | ✅ gave up cleanly after 3 attempts, error says `HTTP 503` |

### 8b.3 The catalog sync algorithm ([src/scraper/catalog.js](src/scraper/catalog.js))
**Phase 1 (sampling):** request listing pages (60 products each) again and again. Each new product is saved
immediately (one `INSERT … ON CONFLICT` per page). The store's `count` field tells us when we're done.

**Phase 2 (gap fill):** once **5% or fewer** are missing, check: *do the IDs we have fit exactly inside a range as
big as the store's count?* (min = 2001, max = 2960, 960 slots = 960 products.) If yes, the missing products must
be exactly the gaps in that range, so we fetch those directly with `/api/v2/items/:id` instead of waiting for
luck. If the range doesn't fit, we just keep sampling. **Nothing is hard-coded**: it works out the range each time.

**Safety:**
- A maximum of 400 listing requests per sync.
- It stops after **5 failed listing requests in a row** (the store looks down) and keeps the existing catalog.
- It only removes products that disappeared from the store when the sync was **complete**.

**When does it run?**
- Automatically when the server starts, if the catalog is empty or older than 24 hours. Render restarts the
  server after it sleeps, so this keeps the catalog fresh for free.
- `npm run catalog:sync` (foreground, with progress output).
- `POST /api/catalog/sync` with the `x-cron-secret` header (background, returns `202`). Only one sync runs at a
  time, so a second request gets "A sync is already running".

**Real results against the live store:**

| Run | Listing requests | Direct item requests | Total | Time | 429 errors | Result |
|---|---|---|---|---|---|---|
| Recon (sampling only, 350ms gap) | 142 | 0 | 142 | – | 24 | 960/960 |
| Sync #1 (`npm run catalog:sync`) | 46 | 46 | **92** | 55s | **0** | ✅ 960/960 |
| Sync #2 (`POST /api/catalog/sync`) | 59 | 16 | **75** | 58s | **0** | ✅ 960/960 |

### 8b.4 Search
The store has no search, so we search our own `catalog_products` table:
- **Every word** must appear in the name, **in any order**, case-insensitive. So `scan nano` finds
  "Tamarack Film Scanner Nano".
- A number also matches the store product ID (`2565`).
- Ranking: exact ID → exact name → names starting with the query → A–Z.
- `%` and `_` are escaped, so typing `%` can't act as a wildcard and match everything.
- Uses parameterised SQL (`$1`, `$2` …), so user input can never inject SQL.

**Product details** (`/api/catalog/products/:id`) are fetched **live** from the store (cached for 10 minutes), because
the options must be current when the user picks one.

### 8b.5 API reference (so far)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/api/health` | – | `{status, database, time}` |
| GET | `/api/catalog/search?q=scanner&limit=20` | – | `{query, results:[{store_product_id,name,brand,category,sku}], catalog:{count,syncing}}` |
| GET | `/api/catalog/status` | – | `{count, lastSyncedAt, syncing, lastResult, lastError}` |
| POST | `/api/catalog/sync` | `x-cron-secret` | `202 {started, message}` |
| GET | `/api/catalog/products/:id` | – | `{store_product_id, name, brand, category, sku, description, specs, option_axis, options:[{id,label}], review_count, review_avg, product_url}` |

Error responses: `400` bad ID · `401` wrong or missing secret · `404` product not in store · `502` store kept failing
after retries (reported honestly, never a fake result).

**Verified against the live store:**
- `scanner` → 12 results
- the full name → exactly 1
- `scan nano` → 1
- `2565` → 1
- `zzzz` / `%` / empty → 0
- product 2565 → option axis "Kit", 4 options (Body only / Standard kit / Creator kit / Pro kit), 7 reviews, average 4.1
- `99999` → 404, `abc` → 400, sync with no or wrong secret → 401, with the correct secret → 202

---

## 9. Running the project locally

### 9.1 Prerequisites
- Node.js **20+** (we use 24). Check with `node -v`.
- A **Supabase** project (free), see 9.2.
- Playwright's browser: `cd backend && npx playwright install chromium`

### 9.2 Create the Supabase database (one time)
1. Go to https://supabase.com → **New project**. Pick region **South Asia (Mumbai)**. Set a database
   password and **save it**.
2. When it's ready, click **Connect** (top bar) → copy the **Session pooler** connection string.
   It looks like `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
   - *Why Session pooler?* Supabase's "direct connection" only works over IPv6, and Render's free tier
     only supports IPv4. The pooler works over IPv4.
3. Put it in `backend/.env` as `DATABASE_URL` (replace `[YOUR-PASSWORD]`).
4. Create the tables using **either** of these:
   - `cd backend && npm run db:migrate`
   - or paste `backend/src/db/schema.sql` into Supabase → **SQL Editor** → Run.

### 9.3 Start the backend
```bash
cd backend
cp .env.example .env      # then fill in DATABASE_URL and CRON_SECRET
npm install
npm run dev               # http://localhost:4000, restarts when files change
```
Check it: open http://localhost:4000/api/health → you should see `"database":"ok"`.

### 9.4 Start the frontend
```bash
cd frontend
cp .env.example .env      # VITE_API_URL=http://localhost:4000
npm install
npm run dev               # http://localhost:5173
```
The page should show **API: ok · Database: ok**.

### 9.5 Commands reference
| Where | Command | What it does |
|---|---|---|
| backend | `npm run dev` | Start the API with auto-restart |
| backend | `npm start` | Start the API (production, used by Render) |
| backend | `npm run db:migrate` | Create or update the tables |
| backend | `npm run catalog:sync` | Collect all store products into `catalog_products` (about 1 minute) |
| frontend | `npm run dev` | Start the Vite dev server |
| frontend | `npm run build` | Build static files into `dist/` (used by Vercel) |
| frontend | `npm run lint` | Lint with oxlint |

---

## 10. Environment variables

**Backend** (`backend/.env` locally, Render → Environment in production)

| Variable | Example | Meaning |
|---|---|---|
| `PORT` | `4000` | Port the API listens on (Render sets this itself) |
| `DATABASE_URL` | `postgresql://postgres.<ref>:…@…pooler.supabase.com:5432/postgres` | Supabase Session pooler connection string |
| `DATABASE_SSL` | `true` | Keep `true` for Supabase |
| `CORS_ORIGIN` | `http://localhost:5173,https://your-app.vercel.app` | Frontends allowed to call the API |
| `CRON_SECRET` | output of `openssl rand -hex 32` | cron-job.org must send it as the `x-cron-secret` header |
| `STORE_BASE_URL` | `https://demo.inelabteamdev.com` | The mock store |
| `HEADLESS` | `true` | `false` opens a visible browser window (headed mode) |

**Frontend** (`frontend/.env` locally, Vercel → Settings → Environment Variables in production)

| Variable | Example | Meaning |
|---|---|---|
| `VITE_API_URL` | `https://your-api.onrender.com` | Backend base URL (no trailing slash) |

> `.env` files hold secrets and are **git-ignored**. Only `.env.example` (no real values) is committed.

---

## 11. Progress tracker

- [x] **Step 0:** Inspect the mock store → [docs/STORE_RECON.md](docs/STORE_RECON.md)
- [x] **Step 1:** Project setup: Vite React frontend, Express backend, database schema, health check, this handbook
  - [x] Supabase project created (region ap-south-1, Session pooler). Migration applied to the real database
        (Postgres 17.6): 4 tables, both CHECK guardrails, the one-running-run index and RLS on all tables verified.
        `/api/health` → `database: ok`
- [x] **Step 2:** Catalog sync + search API (HTTP only): polite HTTP client with retries, 960/960 products
      synced into Supabase, `GET /api/catalog/search?q=`, product details and options → [section 8b](#8b-step-2-catalog-sync-and-search)
- [ ] **Step 3:** Price scraper (Playwright) with retries, validation and honest logging; tracked-product
      routes; history/log API; CSV export; protected cron endpoint; headed-mode script
- [ ] **Step 4:** Dashboard UI: search and pick → tracked product cards → price/stock chart → scrape log → Export CSV
- [ ] **Step 5:** Deploy: Supabase → Render (Docker with Playwright) → Vercel → cron-job.org every 2 h;
      track 2–3 products **immediately** so real history builds up
- [ ] **Step 6:** README, DESIGN_NOTE, headed-run screen recording (you), submit the form

---

## 12. AI usage log (for the design note)

The assignment requires us to say how AI was used and **what it got wrong on the first attempt**.
We record these as they happen.

**How AI is used:** Claude (Claude Code) helped inspect the store, decode the obfuscated bundle, scaffold
the project, design the schema and write code. Every piece is reviewed and explained in this handbook.

| # | Step | What the AI did first | What went wrong | Correction |
|---|---|---|---|---|
| 1 | 0 | Went through catalog pages 1–16 once to list products | Found only 621 of 960, because the listing reshuffles on every request | Keep fetching until all unique IDs (= `count`) are collected |
| 2 | 0 | Sent 25 requests in parallel to measure reliability | nginx rate-limited it: mostly `503` | Sequential requests with delays → 100% success |
| 3 | 0 | Tried to unlock the price with single "hover" events in a browser pane | The gate needs a stream of real `mousemove` events, so it stayed locked | Playwright `mouse.move` in many small steps + a short wait |
| 4 | 0 | (Risk spotted) Reading the obvious `.price-value` / `[data-price]` elements | Those are hidden decoys with **fake** prices | Read only the element with the manifest's real price class |
| 5 | 1 | Wrote a constraint test by building SQL strings by hand | The string building was broken, so valid rows were "rejected" (a bug in the test, not the schema) | Rewrote the test with parameterised queries → 17/17 pass |
| 6 | 1 | CORS middleware threw an error for unknown origins | Returned a noisy `500` with a stack trace | Return "not allowed" quietly, so the browser blocks it and there's no server error |
| 7 | 2 | Collected the catalog by sampling listing pages every ~350ms | 142 requests and **24 × 429** rate-limit errors | 600ms global gap + backoff honouring `Retry-After` + gap fill by ID → 75–92 requests, **0** errors |
| 8 | 2 | The HTTP client reported `attempts = maxAttempts` on every failure | A 404 (tried once) would have been logged as "4 attempts", which isn't honest | Track the real attempt number. Verified: 404 → `attempts=1` |
| 9 | 2 | The first sync loop had no stop condition for a dead store | If the store were down, it would keep retrying 400 pages × 4 attempts for hours | Stop after 5 failed listing requests in a row and keep the existing catalog |

---

## 13. Interview preparation: likely questions

**Q: Why did you use a headless browser? The assignment prefers lightweight fetching.**
We do use lightweight fetching for everything that allows it: the catalog, search and product details.
Only the price needs a browser, because it's protected by a challenge that needs real JavaScript
execution: WebAssembly, canvas/WebGL fingerprinting, trusted mouse interaction and an encrypted response.
Rebuilding that outside a browser would be fragile and would break whenever the store changes its code.

**Q: How do you make sure you never store a wrong price?**
Four layers. (1) We read only the real price element, chosen using the store's own layout manifest,
never the hidden decoys. (2) We check the selected option is the one we track. (3) We reject "pending"
(stale) quotes and anything that doesn't parse to a sensible positive number. (4) The database itself
refuses a success row without a valid price, or a failed row with any data.

**Q: What happens when the store is slow or returns errors?**
Each step has a timeout. We retry with increasing waits (backoff). If every retry fails, we save a
`failed` row with the reason and empty price and stock. The run continues with the next product, and the
next scheduled run tries again. Nothing crashes silently, and nothing is hidden.

**Q: What's the difference between `success`, `retried` and `failed`?**
`success`: correct data on the first try. `retried`: correct data, but only after at least one retry.
`failed`: gave up, with no data stored. The database enforces that the label matches the number of tries.

**Q: Why not `setInterval` or `node-cron` inside the server?**
Render's free tier sleeps the server when there's no traffic, so an in-process timer would stop.
cron-job.org calls our endpoint every 2 hours, which wakes the server and triggers the scrape.

**Q: What if cron fires twice, or while a run is still going?**
Only one `running` row can exist in `scrape_runs` (a unique index). The second trigger is skipped.

**Q: Why is search done on your side?**
The store has no search endpoint and reshuffles its listing on every request. We collect the full
catalog once into our database and search it with SQL.

**Q: How did you get all 960 products if the listing is random every time?**
Two phases. First we sample listing pages until we have about 95%. Random sampling finds new products quickly
at first and very slowly at the end (the "coupon collector" problem). Then, if the IDs we have fit exactly into a
range as large as the store's product count, the missing ones must be the gaps in that range, so we fetch those
few directly by ID. That cut it from 142 requests to 75–92, with zero rate-limit errors. Nothing is hard-coded:
if the range didn't fit, it would just keep sampling.

**Q: How do you avoid being rate-limited?**
All requests go through one client that keeps at least 600ms between requests across the whole server. When
the store sends a 429 or 503, every caller pauses (a global cool-down) and we respect `Retry-After`.
Retries use exponential backoff with random jitter.

**Q: What if the store returns garbage, like an HTML error page or changed JSON?**
Every response is validated against the shape we expect before it's used. Invalid JSON or a wrong shape counts
as a failed attempt and is retried. If it keeps happening, the error is reported with `kind: "shape"`, which is
also the basis for detecting when the store's structure changes.

**Q: How does the frontend talk to the backend securely?**
CORS allows only our frontend origins. The cron endpoint requires a secret header. The database is
reached only by the backend, and Supabase's public REST API is locked with Row Level Security.

**Q: What would you improve with more time?**
Alerts on price drops or restocks, per-product schedules, automatic detection of page-structure
changes, scraping several options in one page visit, and CI/CD with GitHub Actions.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **SPA (single-page app)** | A site where JavaScript builds the page in the browser. The HTML from the server is nearly empty. |
| **Scraping** | Collecting data from a website automatically. |
| **Headless / headed** | A browser running without / with a visible window. |
| **Playwright** | A library to control a real browser from code (click, move the mouse, read the page). |
| **Endpoint** | A URL on a server that returns data, e.g. `/api/v2/items/2565`. |
| **Rate limiting** | A server refusing requests (here `503`/`429`) when they come too fast. |
| **Retry with backoff** | Trying again after a failure, waiting longer each time. |
| **Proof-of-work** | A small puzzle the browser must solve (find a hash with N leading zeros) to show it's willing to spend effort. |
| **WASM (WebAssembly)** | Compiled code that runs in the browser. Here it's used to compute part of the challenge. |
| **Fingerprint** | Details about a browser (graphics card, screen, timing) used to tell real browsers from bots. |
| **Decoy** | Hidden fake content meant to trick scrapers. |
| **Cron** | Running a job on a schedule, e.g. every 2 hours. |
| **CORS** | Browser rule controlling which websites may call an API. |
| **Connection pooler** | A middle layer that shares database connections. Supabase's pooler also gives IPv4 access. |
| **CHECK constraint** | A database rule that rejects rows that break it. |
| **Idempotent** | Safe to run many times with the same result (our schema file). |
| **Row Level Security (RLS)** | Postgres per-row access rules. Enabled with no policies, it blocks Supabase's public API. |
| **ISO 8601 UTC** | Standard timestamp format, e.g. `2026-09-26T14:00:03Z`. |
