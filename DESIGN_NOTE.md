# Design note: INE Price Tracker

## 1. What made this store hard

I started by reading the store before writing any scraper. The HTML is an empty React shell, so I read its
JavaScript bundle and watched its network traffic. Findings (details in [docs/STORE_RECON.md](docs/STORE_RECON.md)):

- **Catalog:** plain JSON endpoints, but **no search**, and the listing is **reshuffled on every request**. One pass over
  all 16 pages found only 621 of 960 products. It is also **rate-limited** (bursts get nginx 503s, fast polling gets 429s).
- **Price:** not in any open endpoint. The page requires real mouse movement over the price box, then does a
  WebAssembly + proof-of-work + browser-fingerprint handshake, and receives an **encrypted** quote.
- **Page traps:**
  - a random option is pre-selected
  - ~17% of clicks are silently dropped (and ~17% delayed)
  - a cookie popup appears at a random time and can need up to 3 clicks
  - two **hidden decoy prices** sit next to the real one
  - class names and layout **rotate** (via a "manifest")
  - the price is shown in **7 formats** (including full-width digits and zero-width spaces between characters)
  - the quote can be **stale** ("Refreshing prices")
  - responses are sometimes slow or 5xx

## 2. How the scraping is made reliable

**Right tool per job.** Catalog, search and product options use lightweight HTTP. Only price and stock use
Playwright, because that page genuinely needs a browser. I considered re-implementing the handshake in Node, but it
would mean faking canvas/WebGL fingerprints and copying a hidden secret from the bundle. It would break on the next
bundle change, so I rejected it.

**Catalog:** one polite HTTP client for every request: a global 600ms gap, 15s timeouts, retries with exponential
backoff and jitter that respect `Retry-After`, a server-wide cool-down after 429/503, and validation of every response's
shape. The sync samples listing pages until ~95% of products are found. Then, if the IDs fill a range exactly as large as
the store's count, it fetches the missing ones directly by ID. Result: **960/960 in 75–92 requests, 0 rate-limit errors**
(versus 142 requests and 24 × 429 for naive sampling).

**Price scraper:** every trap has a specific defence, and nothing is guessed:
- It selects the option by the store's option ID, then verifies it **twice**: the chip's `aria-pressed`, and the
  `?opt=` of the actual quote request the page sent.
- It confirms every click took effect (the panel left its locked state), and re-clicks if not.
- The popup is auto-dismissed whenever it blocks an action, and explicitly before mouse movement.
- It reads the price **only** from the element named by the layout manifest the page itself loaded. That element must be
  the single visible candidate, and a second, independent method (the only visible price-row child that isn't
  MRP / member price / badge) must pick the same element. If they disagree, the attempt fails as "structure changed".
- It never reads a "Refreshing" quote. It requests a fresh one instead.
- Parsing is strict: text that isn't exactly one price in a known format is rejected. It's tested against the
  store's own formatting code (~4,600 generated prices). Then sanity checks: price > 0, price ≤ MRP,
  stock 0 ⇔ "Sold out" badge.

**Retries at four levels:**
1. The store's own in-page retries.
2. "Check again" for stale quotes.
3. Up to 3 attempts per product, each in a **fresh browser context**, with backoff and a hard 120s ceiling per attempt.
4. The next scheduled run.

Errors that retrying can't fix (e.g. the option no longer exists) fail immediately.

**Honest history:** exactly one row per product per run:
- `success` = correct data, first try, no retry at any level
- `retried` = correct data after any retry
- `failed` = no data, with the reason for every attempt

Postgres **CHECK constraints** make it impossible to store a price on a failed row, a missing or zero price on a
successful one, or a `success` label that involved retries. If the database ever rejects a row, a `failed` row explaining
why is written instead, so no attempt disappears. Price history and the scrape log are the same table, so they cannot
disagree. The dashboard shows failed checks as gaps in the chart.

**Unattended operation:**
- Render's free tier sleeps, so cron-job.org triggers `POST /api/cron/scrape` every 2 hours (secret header), and pings
  `/api/health` every 10 minutes to keep it warm.
- The endpoint answers `202` at once and scrapes in the background, because cron-job.org times out at 30s and a run takes ~15s per product.
- A unique index allows **only one running run**.
- Runs left `running` by a dead process are marked `abandoned`. On SIGTERM the server closes its run immediately.
- A browser crash mid-run is recovered by relaunching Chromium for the next product.

## 3. Trade-offs

- **Browser cost vs robustness:** each price check takes ~10–15s and a few hundred MB of RAM. That's acceptable at a
  2-hour interval for a handful of products (tracking is capped at 15), and far more robust than a fake handshake.
- **Sequential and polite:** products are scraped one at a time with one browser. Runs are slower, but the store never
  rate-limits us and memory stays inside Render's 512 MB.
- **Strict over complete:** when the page structure is ambiguous, the scraper records a `failed` attempt rather than
  guessing. I prefer a gap in the history to a wrong number.
- **Catalog snapshot:** search uses our copy of the catalog, refreshed at most daily. A brand-new store product could take up
  to a day to become searchable. Product options are always fetched live when tracking.
- **Free tier:** keeping the service warm uses most of Render's free hours. A cold start (if the ping ever misses) still
  works, just slower.
- **Recording failures on demand:** real failures are random, so headed mode has a `--chaos` flag that injects clearly
  labelled simulated faults with network interception. Those results are never saved.

## 4. How I used AI, and what it got wrong

I built this with an AI coding assistant (Claude, in Claude Code). I used it to inspect the store (reading the minified
bundle and decoding its obfuscated strings), to scaffold the projects, and to write the scraper, API, dashboard, tests and
documentation. I set the requirements and priorities, chose the stack and the visual direction, created and configured the
Supabase, Render, Vercel and cron-job.org services, and checked results against the live store and the live dashboard.
The AI proposed changes; every change was run and tested before it was kept.

Mistakes in its first attempts, and how they were fixed:

| First attempt | What went wrong | Correction |
|---|---|---|
| Listed products by walking catalog pages 1–16 once | Found only 621/960, because the listing reshuffles per request | Sample until the store's `count` is reached, then fill the gaps directly by ID |
| Measured reliability with 25 parallel requests | nginx rate-limited it (mostly 503s) | A single polite client: global gap, backoff, `Retry-After`, shared cool-down |
| Tried to unlock the price with single synthetic hover events | The gate needs a stream of real `mousemove` events plus dwell time | Playwright mouse moves in small steps, then wait, then verify the button is enabled |
| Price parser treated any trailing `,dd` as decimals | `₹1,45` would have become ₹1.45. Caught by our own rejection test | A comma is a decimal only in the store's euro style (`1.45.800,00`). Anything else must pass the digit-grouping check |
| Outcome label counted only the scraper's own retries | A price the store loaded on its 3rd internal try would have been called `success` | Track in-page retries too, and enforce the rule with a DB constraint |
| HTTP client reported the maximum attempt count on every failure | A 404 tried once would be logged as "4 attempts" | Record the real number of tries |
| Catalog sync had no stop condition for a dead store | It could retry for hours | Stop after 5 consecutive failures and keep the existing catalog |
| Read product data as soon as the heading appeared | A race: the heading can render before the product JSON is read | Wait explicitly for the data |

Where the AI's output was right but incomplete, the fix came from testing against the real site. Stale "Refreshing"
quotes, a rotated layout (variant 3 → 0 within a day), full-width digits and a real back-in-stock event were all
seen live and are handled.
