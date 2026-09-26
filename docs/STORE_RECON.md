# Mock store reconnaissance (Step 0)

Target: https://demo.inelabteamdev.com (inspected 2026-09-26)

## What the site is
- A React/Vite single-page app. The HTML is an empty `<div id="root">`, so everything is rendered by JavaScript.
- Routes: `/` (catalog) and `/item/:id` (product page). The store product ID is the number in `/item/:id`.

## JSON endpoints (no auth)
| Endpoint | Returns |
|---|---|
| `GET /api/v2/listings?page=N&limit=L` | `{page, perPage, totalPages, count, results[]}`. `limit` is capped at 60, and there are 960 products. |
| `GET /api/v2/items/:id` | name, brand, category, sku, description, specs, reviews, `optionAxis`, `options[] {id: "o1".., label}`. **No price or stock.** |
| `GET /api/v2/ui/manifest` | Rotating layout: CSS class names per field, element order, price tag, and `priceCarrier` (`text` or `split`). |

Catalog traps:
- **There is no server-side search.** `q`, `search` and `name` are ignored.
- **Listing order is reshuffled on every request.** Walking pages 1..16 once gave only 621 unique IDs out of 960. We need to keep fetching until we've collected all 960 unique IDs, then search locally.
- **Rate limiting.** 25 parallel requests got about 75–100% `503` from nginx. Sequential requests with a ~0.7s gap got 100% `200`.

## Price and stock flow (requires JavaScript)
The price is **not** in any plain endpoint. When the user clicks "Check today's price":
1. The page checks for **human-like interaction**: at least 8 mouse moves over the price panel and at least 600ms of dwell time, and records `event.isTrusted`.
2. `GET /api/v2/handshake` returns `{salt, ts, difficulty, csig, wasm}`.
3. The browser builds a fingerprint (canvas hash, WebGL renderer, requestAnimationFrame timings, screen size, CPU cores) plus the interaction snapshot, runs a **WASM** function, and solves a **SHA-256 proof-of-work**.
4. `POST /api/v2/handshake` returns `{pass}`. A `429` means rate-limited.
5. `GET /api/v2/items/:id/quote?opt=oN` with `Authorization: Bearer <pass>` returns `{blob}`, an **XOR-encrypted** JSON quote. Without the token the response is `401 {"error":"unauthorized"}`.
6. The client retries up to 6 times on upstream errors, with a 300ms×n backoff.

Decoded quote fields: `shown` (selling price), `mrp`, `sale` (member price), `badgePct`, `stock`, `currency`, `at`, `rating`, `ratingCount`, `seller`, `deliveryDays`, `pending`, `format`, `triple`.

## DOM traps on the product page
- **The default option is random** on each load, so we must click the option we're tracking and then check it shows `aria-pressed="true"`.
- **Clicks are dropped on purpose.** 35% of clicks are affected: half are dropped entirely and half are delayed by 900ms. This applies to "Open item" and "Check today's price".
- **Cookie consent modal:** appears 1.5–5s after load (75% chance), at a random position, and may need 1–3 clicks to dismiss. It blocks the page.
- **Decoy prices:** hidden `span.price-value` and `span.amount[data-price]` contain **fake** prices. Other distractors are the struck-through MRP and "Member price …".
- **The real price** is the element with the manifest's `classes.priceValue` class. Its tag and class names rotate, and it has a random `v…` class too.
- **Price formats** vary: `₹1,45,800`, `1 45 800` (spaces), euro style `1.45.800,00`, `…/- (incl. of all taxes)`, full-width Unicode digits, characters separated by NBSP and zero-width spaces, `Rs. 1,45,800.00`, and a `split` layout with one `<span>` per character.
- **`pending` quote:** the price is dimmed (opacity 0.45) with the text "Refreshing prices". This is a stale value and **must not be stored**.
- **Stock text** comes in 5 templates: "N units available", "Last few: N", "Available (N)", "Stock: N remaining", "Ready to ship · N available". "Sold out" means 0.
- **The result panel** can be `offer-ready`, `offer-failed` ("Couldn't load the price after N attempts") or loading/retrying.

## Measured behaviour (Playwright, headless Chromium)
- 11 of 11 scrapes succeeded. Each took about 8–12s, mostly waiting for the consent modal and the interaction gate.
- In 2 of 11 runs the first click was dropped. We detect this when the panel stays `offer-locked` for 1.5s, then click again.
- No handshake or quote errors were seen in this window. Errors, slow responses and layout variants appear to be intermittent, so the scraper must handle them anyway.

## Decision
- **Catalog, search, product details and options:** lightweight HTTP (`fetch`), sequential, with retries. Cache the full catalog in the database and search it locally.
- **Price and stock:** Playwright (headless in production, headed on demand). This page genuinely requires a real browser: WASM, canvas/WebGL fingerprinting, trusted interaction and an encrypted payload. Reimplementing that protocol would be fragile and would break when the bundle changes.

## First-attempt mistakes (for the design note)
- A naive page walk of the shuffled catalog missed about 35% of products.
- Parallel requests triggered nginx `503` rate limiting.
- Synthetic hover events (a single move per call) didn't unlock the price. It needs a real stream of `mousemove` events.
- Reading `.price-value` or `[data-price]` would have stored decoy prices.
