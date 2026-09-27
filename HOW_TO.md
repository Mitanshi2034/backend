# HOW_TO — INE Product Price Tracker

> This is our working handbook. It explains **what** we are building, **what we found out** about the
> store, **why** we made each decision, **how** to run everything, and **what to say** when someone asks.
> It is updated at the end of every step.

**Deadline:** Sunday 27 September 2026, 11:59 PM IST. Submit at https://forms.gle/6LGyJV9yi6W1gna18

| Live | URL |
|---|---|
| Dashboard (Vercel) | https://ine-tracker-price.vercel.app |
| API (Render) | https://ine-price-tracker-api-iwhp.onrender.com (health: `/api/health`) |
| Repos | https://github.com/Mitanshi2034/backend · https://github.com/Mitanshi2034/frontend |

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
   - [Step 3: the price scraper, runs, history, CSV, cron](#8c-step-3-the-price-scraper-runs-history-csv-cron)
   - [Step 4: the dashboard](#8d-step-4-the-dashboard)
   - [Step 5: deployment](#8e-step-5-deployment)
   - [Step 6: submission](#8f-step-6-submission)
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
├── README.md                 ← (Step 6) setup, schedule, env vars, API (required by the assignment)
├── DESIGN_NOTE.md            ← (Step 6) reliability, trade-offs, AI usage (required by the assignment)
├── docs/
│   └── STORE_RECON.md        ← raw technical notes from inspecting the store
├── .gitignore                ← keeps node_modules and .env (secrets) out of Git
├── package.json              ← dependencies and scripts (start, dev, db:migrate, catalog:sync)
├── .env.example              ← template of every environment variable (copy to .env)
├── Dockerfile                ← (Step 5) Playwright-based image for Render
├── render.yaml               ← (Step 5) Render Blueprint (service settings + env var list)
├── scripts/
│   ├── migrate.js            ← runs schema.sql against the database
│   ├── sync-catalog.js       ← (Step 2) collect all 960 products now, with progress output
│   └── scrape-headed.js      ← (Step 3) visible-browser run for watching/recording (+ --chaos faults)
├── test/
│   └── parse.test.js         ← (Step 3) price/stock parser tests using the store's own formatting code
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
    │   ├── catalog.js        ← (Step 2) catalog sync algorithm, search, product details
    │   ├── parse.js          ← (Step 3) strict price/stock text → number (refuses anything ambiguous)
    │   ├── browser.js        ← (Step 3) launches Chromium (one per run)
    │   ├── price.js          ← (Step 3) THE price scraper: every trap's defence, retries, validation
    │   └── runner.js         ← (Step 3) a "run": pick products, scrape one by one, record every attempt
    └── routes/
        ├── health.js         ← GET /api/health: is the API up, is the DB reachable?
        ├── catalog.js        ← (Step 2) /api/catalog/search, /status, /sync, /products/:id
        ├── tracked.js        ← (Step 3) add/list/update/delete tracked products, history, "scrape now"
        ├── runs.js           ← (Step 3) recent scrape runs (proof the scheduler fired)
        ├── export.js         ← (Step 3) CSV download of every scrape attempt
        └── cron.js           ← (Step 3) POST /api/cron/scrape, called by cron-job.org
```

**frontend repo**
```
frontend/
├── README.md                 ← short intro, links back to this handbook
├── index.html                ← page shell, fonts (Instrument Sans + IBM Plex Mono), theme colour
├── public/favicon.svg        ← the amber tag mark
├── .env.example              ← VITE_API_URL template
└── src/
    ├── main.jsx              ← mounts <App /> into the page
    ├── App.jsx               ← (Step 4) layout, auto-refresh (20s, or 4s while a run is active)
    ├── api.js                ← every call to the backend goes through here
    ├── index.css             ← (Step 4) the whole dark glass design system (tokens + components)
    ├── lib/format.js         ← ₹ formatting, "5 min ago", local date/time
    └── components/
        ├── SearchPanel.jsx   ← search → open product → pick option → track
        ├── TrackedList.jsx   ← tracked products with latest price + outcome
        ├── ProductDetail.jsx ← header, actions, stats, charts, log for the selected product
        ├── HistoryCharts.jsx ← price chart + stock chart (shared time axis, failures marked)
        ├── ScrapeLog.jsx     ← every attempt, filterable by outcome
        ├── RunsPanel.jsx     ← recent runs (proof the scheduler fires)
        └── OutcomeBadge.jsx  ← hand-drawn SVG shape + label per outcome
```


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

## 8c. Step 3: the price scraper, runs, history, CSV, cron

This is the core of the assignment. **The file to know best is [src/scraper/price.js](src/scraper/price.js).**

### 8c.1 What one scrape does, step by step
| # | Step | Trap it beats (section 5.5) |
|---|---|---|
| 1 | Open a **fresh browser context** (clean cookies and state) and start **listening to the page's own network traffic** | – |
| 2 | Register an **auto-dismiss handler** for the cookie popup: whenever it blocks a click, Playwright clicks "Reject" until it's gone | 3 |
| 3 | Open `/item/:id`. Wait for the heading, or the store's "Couldn't load this product" error | 11 |
| 4 | **Check we're on the right product**: the product JSON the page loaded has our ID, and the heading matches its name | shifted page |
| 5 | Take the **layout manifest the page itself loaded** (class names change over time). If it failed, this attempt fails | 7 |
| 6 | Find our option **by the store's option ID** (`o2`), click its chip, and check `aria-pressed="true"` | 1 |
| 7 | Wait out the popup window (5.5s after load) and dismiss it before moving the mouse | 3 |
| 8 | **Move the mouse** across the price box in 14 small steps, 60ms apart, then wait 700ms, until the button enables | 4 |
| 9 | Click "Check today's price" and **confirm the page reacted** (the panel leaves the locked state). If not, click again (up to 4 times) | 2 |
| 10 | Wait up to **60s** for the result: ready, or the store's own "Couldn't load the price after N attempts" | 11 |
| 11 | If the quote says **"Refreshing prices"** (stale), don't read it. Click "Check again" and wait for a fresh quote (up to 3 times) | 9 |
| 12 | Read the rendered quote in one pass. **Exactly one** element with the manifest's price class, visible, **and** a second, independent method (the only visible child of the price row that isn't MRP/member price/badge/status) must pick **the same element** | 5, 6 |
| 13 | Check the **selected option** is still ours **and** the last `quote?opt=` request the page made was for our option, with HTTP 200 | 1 |
| 14 | **Parse strictly** (`parsePrice`, `parseStock`), then sanity-check: price > 0, price ≤ MRP, stock 0 ⇔ "Sold out" badge | 8, 10 |

If any step fails, the attempt throws a `ScrapeError` with a clear message and a `kind`
(`load`, `structure`, `store`, `timeout`, `validation`, `option`).

### 8c.2 Four levels of retry
1. **The store's own retries**: the page retries its price request up to 6 times. We count these (`page_retries`).
2. **"Check again"** for stale quotes (up to 3), also counted in `page_retries`.
3. **Our retries**: up to **3 attempts** per product, each in a **fresh browser context**, waiting 3s and then 6s.
   Each attempt has a hard **120s ceiling**. Things that can't be fixed by retrying (e.g. the option no longer exists)
   fail immediately.
4. **The next scheduled run**, 2 hours later.

### 8c.3 Outcome rules (and who enforces them)
| Outcome | Meaning | Enforced by |
|---|---|---|
| `success` | Correct data on the first attempt, **no retry at any level** (`attempts = 1`, `page_retries = 0`) | runner **and** DB constraint |
| `retried` | Correct data, but only after our retry **or** an in-page re-request | runner **and** DB constraint |
| `failed` | No trustworthy data after all attempts → price and stock **NULL**, with the reason for every attempt in `error` | runner **and** DB constraint |

If the database ever refuses a row (a guardrail fired), the runner **still records a `failed` row** explaining why,
so an attempt is never silently lost.

### 8c.4 Runs ([src/scraper/runner.js](src/scraper/runner.js))
- `createRun(trigger)` inserts a `scrape_runs` row. The unique index makes a second concurrent run fail
  (`RunInProgressError`). A `running` row older than 30 minutes (from a server that died) is marked `abandoned` first.
- `executeRun(run)`:
  - picks the products that are due (`last_scraped_at` older than their interval minus 15 minutes of tolerance)
  - scrapes them **one by one** with **one shared browser**, relaunching it if it crashes
  - writes **one row per product** (in a transaction, together with `last_scraped_at`)
  - picks up products **added while it was running**
  - always closes the run row with counts
- The cron endpoint and the "scrape now" button **reply immediately** (`202`) and run in the background.

### 8c.5 API reference (added in Step 3)
| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/api/tracked` | – | All tracked products with latest price/stock/outcome, last success, attempt counts, min/max price, extra info |
| POST | `/api/tracked` | – | `{store_product_id, option_id}` → checks both against the live store, saves, **starts the first scrape immediately**. `409` if already tracked, `400` bad option, `404` unknown product, max 15 |
| PATCH | `/api/tracked/:id` | – | `{scrape_interval_minutes (60–1440), is_active}` (bonus: per-product frequency, pause) |
| DELETE | `/api/tracked/:id` | – | Stop tracking (also deletes its history) |
| GET | `/api/tracked/:id/history?limit=500` | – | `{product, attempts[]}`: the scrape log. The chart uses the non-failed rows |
| POST | `/api/tracked/:id/scrape` | – | "Scrape now": `202`. `429` if scraped less than 2 minutes ago, `409` if a run is in progress |
| GET | `/api/runs?limit=20` | – | Recent runs: trigger, status, counts, times |
| GET | `/api/export/scrapes.csv` | – | CSV download (see below) |
| POST | `/api/cron/scrape` | `x-cron-secret` | Scheduled run: `202 {started, run_id}`, or `200 {started:false}` if a run is still going |

**CSV format** (one row per attempt, oldest first, `\r\n` line endings, RFC 4180 quoting):
```
store_product_id,product_name,selected_option,timestamp,price,stock,outcome
2565,Tamarack Film Scanner Nano,Standard kit,2026-09-26T15:09:36.716Z,23582,114,success
2630,Saffrix Violin Nano,Studio bundle,2026-09-26T15:09:57.431Z,102578,100,retried
2565,Tamarack Film Scanner Nano,Standard kit,2026-09-26T17:00:04.120Z,,,failed      ← (example) failed: price & stock empty
```

### 8c.6 Headed mode (for the screen recording)
```bash
cd backend
npm run scrape:headed                                        # all tracked products, visible browser, nothing saved
npm run scrape:headed -- --product 2565 --option o2          # one product option
npm run scrape:headed -- --product 2565 --option o2 --chaos  # + SIMULATED slow/failing responses
npm run scrape:headed -- --save                              # real run, saved as trigger 'cli'
npm run scrape:headed -- --slow 250                          # slower actions (default 120ms)
```
- A **status banner** is drawn at the bottom-left of the store page ("Scraper · Attempt 1/3 · moving the mouse over the price area"),
  so the video explains itself. The terminal prints the same steps with timestamps.
- `--chaos` injects clearly labelled **simulated** faults with Playwright's network interception:
  - the layout request fails on attempt 1 → our retry with a fresh page
  - the handshake is delayed by 5s → we wait for a slow response
  - two price requests return 503 → the store's retry, then the result is labelled `retried`

  Chaos results are **never saved**.
- Suggested recording: first a normal run (real traps: popup, dropped click, maybe a real 503), then a `--chaos` run.

### 8c.7 Test results
| Test | Result |
|---|---|
| Parser unit tests (`npm test`): ~4,600 prices generated with the **store's own formatting code**, 7 formats × 2 carriers, + rejection cases + stock templates | ✅ 6/6 |
| DB guardrails (PGlite): 19 cases incl. new `page_retries` rules | ✅ 19/19 |
| Live scrapes (4 product options) | ✅ 4/4 correct. Real traps seen: **2 stale "Refreshing" quotes** caught and re-requested, **a real store 503** recovered in-page (→ `retried`), `Rs. 27,705.00` format, **Sold out** → 0 |
| Chaos run (manifest 503 + 5s slow + 2 quote 503s + a dropped click) | ✅ same correct price, `retried`, attempts 2, in-page retries 2 |
| End-to-end on **Supabase** via the API: track 3 products → one run scraped all 3 (2 were picked up mid-run) | ✅ 3/3. The **layout rotated from variant 3 to 0** since the morning, and the scraper adapted automatically. Raw price stored: `₹​２​３​,​５​８​２` (full-width digits + zero-width spaces) → 23582 |
| Failure path (throwaway DB, every price request forced to fail) | ✅ `failed`, price/stock NULL, 3 attempts with reasons. A removed option fails **immediately** (no pointless retries). The run closed with counts |
| Validation: duplicate → 409, bad option → 400, unknown product → 404, cron without secret → 401, cron during a run → "already in progress", scrape-now cooldown → 429 | ✅ |

---

## 8d. Step 4: the dashboard

### 8d.1 What's on the screen
| Area | What it shows / does |
|---|---|
| **Top bar** | Name, **scheduler status** ("Last scheduled check 18 min ago", or a pulsing "Checking prices now…"), **Export CSV** button |
| **Track a product** | Search as you type (debounced 250ms, out-of-order responses ignored) → open a product (brand, category, rating, description) → pick one option → **Track this option** (first check starts immediately) |
| **Tracked** | Each tracked product option with its latest price, the last outcome badge and "x min ago". If the latest check **failed**, it says so and says how old the price shown is, instead of silently showing an old price as current |
| **Recent runs** | The last runs with trigger (Scheduled / Manual / CLI) and result ("3/3 ok", "nothing due", "running…") |
| **Product detail** | Category, ID and SKU, name, option, link to the store. **Actions:** Check now, frequency (2 h … daily), Pause/Resume, Remove. **Stats:** current price (+ MRP and % off), stock (+ delivery), price range, checks with data / total (failed, retried). **Last check** line with seller and rating. **Charts** and **scrape log** |

The page refreshes itself every 20 seconds, and every 4 seconds while a run is in progress, so new results appear without reloading.

### 8d.2 Chart decisions (why the charts look the way they do)
- **Two charts, not one with two y-axes.** Price (₹) and stock (units) are different scales. Dual-axis charts
  mislead, so they're stacked on a **shared time axis** with a **synced crosshair** (hovering one shows the same moment in both).
- **Failures are visible.** A failed check has no data, so the line **breaks** there, and a thin **red rule**
  marks the time. Nothing is interpolated across a failure.
- **Stock is a step line** (stock stays at a value until the next check), price is a straight line between checks.
- **Round, evenly spaced ticks** (₹23k / ₹24k / ₹25k; 0 / 50 / 100 / 150) from a small "nice ticks" function.
- **Colour:** one data colour (blue `#3987e5`), validated for contrast and colour-blindness on the dark surface.
  Outcome colours (green / amber / red) are reserved for status and **always paired with a shape and a word**,
  so nothing relies on colour alone.
- **The scrape log table is the chart's table view**: every value on the chart is also readable there.

### 8d.3 Visual design
- **Dark, frosted glass**: translucent panels with background blur, hairline borders and a faint top highlight
  over a near-black backdrop with two soft off-centre glows (teal, amber) and a fine film-grain texture.
- **One accent colour** (amber) for actions and selection. Blue is kept for data only.
- **Type:** Instrument Sans for text, IBM Plex Mono for table numbers and axis ticks (tabular figures line up).
- **No emoji or icon packs.** Outcome markers are three tiny hand-drawn SVG shapes: filled dot = success,
  broken ring = retried, cross = failed. The logo is a CSS-drawn price tag.
- **Responsive:** two columns on desktop, one column under 1000px, 16px side gutters on phones and no horizontal scrolling
  (the log table scrolls inside its own box).
- **Accessible:** keyboard focus rings, labelled controls, row buttons with full spoken labels, reduced-motion support.

### 8d.4 Redesign (27 Sep): separate pages, like real price trackers
After comparing with PriceHistory.app, CamelCamelCamel and Keepa (product list + a dedicated page per product, a big
price, lowest/average/highest, the chart as the centrepiece, and highlights for drops and restocks), the single
crowded screen was split into pages:
- **Overview** `/`: summary row, product cards (price, change since last check, sparkline, stock), a "Track another
  product" tile, and an **Alerts** panel. This is the **alerts** bonus: price drop/rise, back in stock, sold out, and
  **store layout changed**, which covers the change-detection bonus since the store switched layout variant 5 → 2 overnight.
- **Product** `/product/:id`: big price + change chip + MRP, facts, "Today's price is low / typical / high" bar
  (lowest–average–highest), charts with **24 h / 3 days / All** tabs, the product's changes, its scrape log.
  Secondary actions moved into a **⋯ menu** (frequency, stop tracking). **Pause was removed** (not in the brief).
- **Activity** `/activity`: all attempts across products + Export CSV. **Status** `/status`: scheduler health + run history.
- **Track a product** is a pop-up search available on every page.
- **Brand: CIPHER.** The store encrypts its prices and this app decodes them, hence the name. The mark is a hand-drawn SVG
  amber tile with a falling price line ending in a dot. The wordmark is set in **Michroma**, all caps, with wide letter-spacing.
  Michroma has a single weight, so a thin same-colour text stroke gives it a bolder look.
- Backend support: `GET /api/attempts`, `GET /api/changes` (SQL window function `lag()` over successful checks),
  `GET /api/stats`, and `/api/tracked` now includes previous price, average and a 24-check trend.
- `vercel.json` rewrites all paths to `index.html` so deep links survive a refresh.

### 8d.5 Verified in the browser (against the real Supabase data)
- Desktop 1440×1000: the layout, glass panels, backdrop glows, stats and charts all render
- **Check now** → the button changes to "Checking…" and the run shows "running…". After about 18s, **without a reload**, the new row
  appeared: it was `Retried` with "store needed 3 tries to load the price" (a real store failure, honestly logged), the chart
  drew its line, and the runs list showed "1/1 ok"
- Search "film scan" → 12 results → open "Halvard Film Scanner Ultra" → options shown → select "Standard kit" → Track enabled
- Phone 375×812: single column, page width = 375 (no sideways scroll)
- `oxlint`: 1 remaining warning (the data-refresh effect, intended). `vite build` OK. Backend tests 6/6

---

## 8e. Step 5: deployment

```
 Vercel (frontend)  ──calls──▶  Render (backend, Docker + Chromium)  ──SQL──▶  Supabase
                                   ▲                 ▲
          cron-job.org: POST /api/cron/scrape        cron-job.org: GET /api/health
          every 2 hours (the schedule)                every 10 min (keeps it awake)
```

### 8e.1 Files added for deployment
| File | Purpose |
|---|---|
| `Dockerfile` | Built on Microsoft's official **Playwright image** (`mcr.microsoft.com/playwright:v1.63.0-noble`), which already has Node, Chromium and all the Linux libraries Chromium needs. Its tag matches the pinned `playwright` version. Runs `npm ci --omit=dev`, then `node src/index.js` |
| `.dockerignore` | Keeps `node_modules`, `.env` (secrets) and git history out of the image |
| `render.yaml` | Render Blueprint: Docker, free plan, **Singapore** (nearest to Supabase Mumbai), health check `/api/health`, environment variable list |
| `src/index.js` (shutdown) | On `SIGTERM` (deploy, restart, sleep) any `running` run is immediately marked `abandoned` with the reason, so it never blocks the next scheduled run |
| `src/scraper/browser.js` | `--disable-dev-shm-usage`: Docker's shared memory is tiny, and Chromium crashes without this flag |

**Why Docker on Render?** Render's normal Node environment doesn't have Chromium's system libraries. The official
Playwright image does, so the same scraper that works locally works on Render.

### 8e.2 Render (backend): one time
1. https://render.com → **Sign in with GitHub** (Mitanshi's account) and allow access to the `backend` repo.
2. **New → Web Service** → pick `Mitanshi2034/backend`.
   - Language/Runtime: **Docker** (detected from the Dockerfile) · Branch: `main` · Region: **Singapore** · Instance type: **Free**
   - Name: `ine-price-tracker-api` (the URL becomes `https://ine-price-tracker-api.onrender.com`, or similar if taken)
3. **Environment Variables** (copy the first two values from your local `backend/.env`):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase Session pooler URL (same as `backend/.env`) |
   | `CRON_SECRET` | same as `backend/.env` |
   | `CORS_ORIGIN` | `http://localhost:5173` for now (the Vercel URL is added in step 8e.3) |
   | `DATABASE_SSL` | `true` |
   | `HEADLESS` | `true` |
   | `STORE_BASE_URL` | `https://demo.inelabteamdev.com` |
4. **Advanced → Health Check Path:** `/api/health` → **Deploy Web Service**. The first build takes about 5–10 minutes
   (the Playwright image is large).
5. Check it: open `https://<your-service>.onrender.com/api/health` → `{"status":"ok","database":"ok",…}`.

### 8e.3 Vercel (frontend): one time
1. https://vercel.com → **Continue with GitHub** (Mitanshi) → **Add New → Project** → import `Mitanshi2034/frontend`.
2. Framework preset **Vite** (auto-detected; build `npm run build`, output `dist`).
3. **Environment Variables:** `VITE_API_URL` = `https://<your-service>.onrender.com` (no trailing slash) → **Deploy**.
4. Note the URL (e.g. `https://frontend-xyz.vercel.app`). Project Settings → Domains lets you pick a nicer
   `*.vercel.app` name, e.g. `ine-price-tracker.vercel.app`.
5. Back in **Render → Environment**, set `CORS_ORIGIN` to `https://<your-vercel-url>,http://localhost:5173` and save
   (Render redeploys automatically). Without this, the browser blocks the dashboard's API calls.

> `VITE_*` variables are baked in **at build time**. If the backend URL changes, redeploy the frontend.

### 8e.4 cron-job.org (the schedule): one time
Create a free account at https://cron-job.org, set your time zone to Asia/Kolkata, then create **two** jobs:

| | Job 1: **INE price scrape** | Job 2: **INE keep warm** |
|---|---|---|
| URL | `https://<your-service>.onrender.com/api/cron/scrape` | `https://<your-service>.onrender.com/api/health` |
| Schedule | **Every 2 hours at minute 13**: Custom → crontab `13 */2 * * *` | Every 10 minutes |
| Advanced → Request method | **POST** | GET |
| Advanced → Headers | `x-cron-secret` = the `CRON_SECRET` value | – |
| Expected result | `202 {"started":true,"run_id":…}` (or `200 {"started":false}` if a run is still going) | `200 {"status":"ok"}` |

Use **Test run** on Job 1 and check that the dashboard's "Recent runs" shows a **Scheduled** run.

**Why the keep-warm job?** Render's free tier sleeps after 15 minutes without traffic, and waking takes up to a
minute, longer than cron-job.org's 30s timeout. A cheap `/api/health` ping every 10 minutes keeps it awake. (One
always-on free service uses about 730 of the 750 free hours a month.) Even without it, the scrape still
happens: Render holds the request while waking and our endpoint answers straight away.

### 8e.5 Deployment results (26 Sep 2026)
| Check | Result |
|---|---|
| Render build (Docker, Playwright image) | ✅ live at https://ine-price-tracker-api-iwhp.onrender.com |
| `/api/health`, catalog (960), search, tracked, runs on Render | ✅ all 200, ~0.2–0.8s |
| **Playwright on Render**: manual check of Veloria E-Reader Go / 64 GB | ✅ success in 15.5s. A dropped click was handled. Price ₹27,705 → **₹26,494**, stock Sold out → **46** (back in stock) |
| Vercel build uses the Render URL; CORS allows only `https://ine-tracker-price.vercel.app` (+ localhost) | ✅ |
| Cron endpoint with wrong/missing secret | ✅ 401 |
| cron-job.org **Test run** | First try `401`: the header **key** had been entered as `CRON_SECRET`. Fixed to `x-cron-secret` → ✅ `202 Accepted` in 373ms |
| First scheduled run (run 8) | ✅ 2/2 succeeded. Veloria correctly **skipped** (checked 37 min earlier, not due). Tamarack ₹23,582 → **₹15,837** (MRP also changed 38,035 → 22,306); Violin ₹1,02,578 → **₹1,52,231**, sold out. Raw texts confirm both (`₹1,52,231` with zero-width spaces) |
| CSV from the live API | ✅ attachment, 7 required columns, ISO UTC timestamps |

### 8e.6 Production incident: rate limiting (27 Sep, 08:00 IST)
- Runs 10–12 (02:00, 04:00, 06:00 IST): 3/3 each. **Run 13 (08:00): 0/3**. Every product got `product 429` /
  `manifest HTTP 429` on all 3 attempts.
- Cause: the store rate-limits by IP. Render's outgoing IPs are shared, and other scrapers of this store fire at minute 0.
  Our 3s/6s backoff retried inside the same limit window.
- Fix: rate-limit-aware backoff (20s/45s/90s), 60s pause before the next product, a **second pass** after a 2-minute
  cool-down, and the cron minute moved from `0` to **`13`** (still every 2 hours).
- The failures stay in the history as they happened. Nothing was edited.

### 8e.7 After deploying
- Track **2–3 products** on the live site (the 3 from local testing are already in Supabase, so they appear
  automatically, because local and live share the same database).
- Leave it running: each scheduled run adds one row per product to the history and the log.
- Troubleshooting: **Render → Logs** shows every run step by step (`[run 12] ▶ …`, `✓`/`✗`).

---

## 8f. Step 6: submission

### 8f.1 Documents
| File | Required by the assignment? | Contents |
|---|---|---|
| `README.md` (backend) | ✅ setup, schedule, env vars | Live links, how it works, **scraping schedule**, local setup, commands, headed mode, **environment variables**, API, CSV format, deployment |
| `README.md` (frontend) | – | Live link, features, run locally, `VITE_API_URL`, Vercel |
| `DESIGN_NOTE.md` | ✅ | What made the store hard · how reliability was achieved · trade-offs · **how AI was used and what it got wrong first** |
| `HOW_TO.md` | – (our handbook) | Everything, in detail |

> **Check the AI section of DESIGN_NOTE.md** and make sure it describes exactly how you worked. The assignment requires
> an honest disclosure, and the interviewers may ask about it.

### 8f.2 Recording the headed run (2–4 minutes)
**Before recording:**
- Close other windows, set the screen to 1080p if possible, and open a terminal in `backend/` with a large font.
- Do one practice run (below) so Chromium is warm.
- Use QuickTime (File → New Screen Recording) or ⌘⇧5 on macOS, and record the whole screen with the microphone on.

**Script:**

| Time | Do this | Say (roughly) |
|---|---|---|
| 0:00–0:20 | Show the live dashboard (https://ine-tracker-price.vercel.app): tracked products, charts, scrape log, recent runs | "This tracks INE's mock store every 2 hours via cron-job.org. Every attempt is logged, failures included." |
| 0:20–1:30 | `npm run scrape:headed -- --product 2565 --option o2` | Narrate the banner as it goes: "It opens the product page, reads the layout manifest, selects the option by its store ID… waits out and dismisses the cookie popup… moves the mouse to pass the interaction gate… clicks and checks the click registered… reads the one real price, not the hidden decoys, and parses it strictly." Point at the terminal result line. |
| 1:30–3:00 | `npm run scrape:headed -- --product 2565 --option o2 --chaos` | "Now with simulated faults. First the layout request fails (503), so the attempt fails and it **retries with a fresh page**. Then the handshake is **5 seconds slow**, and it waits. Then two **price requests fail with 503**; the page retries and the result is labelled **retried**, not success." Show the final RESULT line: `RETRIED · attempts 2 · in-page retries 2`. |
| 3:00–3:30 | Back on the dashboard: open the scrape log, filter **Retried** / **Failed**, click **Export CSV** | "Failed attempts are stored with empty price and stock. Here's the CSV with one row per attempt." |

If a real store failure happens during the normal run (a 503, a dropped click, a stale quote), point it out, because it's the best evidence.

### 8f.3 Submission checklist (form: https://forms.gle/6LGyJV9yi6W1gna18)
- [ ] Live site link: https://ine-tracker-price.vercel.app
- [ ] GitHub repo(s): https://github.com/Mitanshi2034/backend (+ https://github.com/Mitanshi2034/frontend)
- [ ] Screen recording (2–4 min, headed mode, slow/failing responses), uploaded as a shareable link (Google Drive/YouTube unlisted)
- [ ] README with setup, schedule, env vars (backend README)
- [ ] Design note (backend `DESIGN_NOTE.md`)
- [ ] PDF resume
- [ ] Before submitting: the dashboard shows several **Scheduled** runs in "Recent runs"
- [ ] Revoke the GitHub token that was pasted in chat

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
| backend | `npm run scrape:headed` | Visible-browser scrape (see 8c.6 for options) |
| backend | `npm test` | Parser unit tests |
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
- [x] **Step 3:** Price scraper (Playwright) with retries, validation and honest logging; tracked-product
      routes; history/log API; CSV export; protected cron endpoint; headed-mode script → [section 8c](#8c-step-3-the-price-scraper-runs-history-csv-cron)
  - [x] **10 products tracked**, one per store category (27 Sep): Tamarack Film Scanner Nano, Veloria E-Reader Go,
        Saffrix Violin Nano, Saffrix Desk Lamp Arc, Junova Spin Bike Edge, Tundrel Handheld Console Flex, Redwick Smart
        Panel Nano, Brightwell Mesh System Nano, Quarrow Hammock Edge, Lumeno Hair Dryer Prime. The 6 added together
        were scraped in one run (run 18: 6/6). Runs now pause 4s between products to stay polite at this size
- [x] **Step 4:** Dashboard UI: search and pick → tracked products → price/stock charts → scrape log → runs → Export CSV → [section 8d](#8d-step-4-the-dashboard)
- [x] **Step 5:** Deploy: Supabase → Render (Docker with Playwright) → Vercel → cron-job.org every 2 h → [section 8e](#8e-step-5-deployment)
  - [x] Scrape job live (every 2 h, POST + `x-cron-secret`), first scheduled run succeeded
  - [x] Keep-warm job (GET `/api/health` every 10 min)
- [x] **Step 6 (docs):** README (both repos), DESIGN_NOTE → [section 8f](#8f-step-6-submission)
- [ ] **Step 6 (you):** headed-run recording, resume, submit the form (checklist in 8f.3)

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
| 10 | 3 | The first price parser treated any `,dd` ending as decimals | `₹1,45` would have been stored as **₹1.45**. Caught by our own rejection test | A comma is a decimal only in euro style (`1.45.800,00` / `…,00`). Otherwise the grouping check rejects it |
| 11 | 3 | The first outcome rule only counted **our** retries | A price the store loaded on its 3rd internal try would have been labelled `success`, which isn't honest | Added `page_retries` (store retries + "Check again") and made the DB constraint require `retried` in that case |
| 12 | 3 | Checked the product JSON as soon as the heading appeared | Race: the heading can render before the network listener has read the JSON | Wait for the data explicitly (up to 5s) |
| 13 | 3 | Adding several products only scraped the first one immediately | Others would wait up to 2 h because a run was already in progress | A run now picks up products added while it's running |
| 14 | 3 | Stored the seller name as displayed | It contained a hidden zero-width character (`Mar​lowe & Co`) | Clean invisible characters from display fields (the raw price text is kept untouched as evidence) |
| 15 | 3 | `npm test` pointed Node at a folder | Node 24 doesn't accept a directory there, so the tests didn't run | Use a file pattern (`test/*.test.js`) |
| 16 | 4 | Put the page colour on `<body>` | It painted over the fixed backdrop layers, so the glows and grain were invisible | Page colour on `:root`, body transparent |
| 17 | 4 | Let the chart pick its axis range from padded min/max | Uneven ticks like ₹23.3k / ₹23.7k / ₹24.1k and 0 / 35 / 70 / 132 | A "nice ticks" function (1, 2, 2.5, 5 × 10ⁿ steps) |
| 18 | 4 | Showed the price range as "min – max" | With one data point it read "₹23,582 – ₹23,582" | Show a single value and "no change yet" |
| 19 | 4 | Remove cleared the selection after the request, whether or not it succeeded | A failed delete would still have deselected the product | Clear the selection only after the delete succeeds |
| 20 | prod | Retried failed products after 3s / 6s | The 08:00 IST scheduled run (run 13) got **HTTP 429** from the store on every request (shared Render IP, other scrapers at the top of the hour). All 3 attempts fell inside the limit window, so 0/3, logged honestly as failed | Detect 429 → back off 20/45/90s; pause 60s before the next product; second pass after a 2-min cool-down (one row, attempts from both passes); move cron off minute 0. Tested with simulated 429s |

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

**Q: Walk me through one scrape.**
Fresh browser context → open the product page → check it's the right product → take the layout manifest the page
loaded → select our option by ID → wait out and dismiss the cookie popup → move the mouse over the price area until
the button enables → click and confirm the click registered → wait for the quote → reject stale "Refreshing" quotes
→ read the one real price element (confirmed by two independent methods) → check the option in the UI and in the
network request → parse strictly → sanity-check → save one row. (Section 8c.1.)

**Q: How do you know you didn't read a decoy price?**
Three independent checks must agree. It's the element with the class from the store's own layout manifest. It's
visible (the decoys are `display:none`). And a second method (the only visible child of the price row that isn't
the MRP, member price, badge or a status label) picks the same element. If they disagree, the attempt fails as a
"structure changed" error instead of guessing.

**Q: How do you know the price is for the right option?**
We select the option by the store's option ID and check `aria-pressed`. We also watch the network: the last
`/quote?opt=…` request the page made must be for our option ID and must have returned 200.

**Q: What is the difference between an attempt and a page retry?**
An attempt is our retry with a completely fresh browser context (up to 3). A page retry is the price being
requested again inside the same page, either the store's own retry or our "Check again" for a stale quote.
Either kind means the outcome is `retried`, not `success`.

**Q: How did you record the headed video showing failures if failures are random?**
Real traps (popup, ignored clicks, stale quotes, occasional 503s) appear naturally. To show slow and failing
responses on demand, `--chaos` uses Playwright's network interception to inject clearly labelled simulated faults:
a failed layout request, a 5-second delay and two 503s. Those results are never saved to the database.

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
