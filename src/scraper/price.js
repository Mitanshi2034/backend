import { config } from '../config.js'
import { sleep } from './http.js'
import { parsePrice, parseStock, ParseError } from './parse.js'

// Price + stock scraper (Playwright).
//
// The store only reveals a price after browser checks (real mouse movement,
// WASM, fingerprinting, encrypted response), so this part uses a real browser.
// Every trap found in Step 0 has a matching defence below (see HOW_TO.md 5.5):
//   1 random default option  -> select ours, verify aria-pressed AND the ?opt= of the quote request
//   2 dropped clicks         -> confirm the page reacted, otherwise click again
//   3 cookie popup           -> auto-dismiss handler + explicit dismiss before mouse moves
//   4 interaction gate       -> stream of real mouse moves + dwell, until the button enables
//   5/6 decoys & look-alikes -> read ONLY the manifest's price element, cross-checked by a second method
//   7 rotating layout        -> use the manifest the page itself loaded
//   8 price formats          -> parsePrice() (strict, refuses ambiguity)
//   9 "Refreshing prices"    -> never read; click "Check again" and wait for a fresh quote
//  10 stock phrasings        -> parseStock()
//  11 slow / failing store   -> timeouts, store's own retries, then our retries with a fresh page

export class ScrapeError extends Error {
  constructor(message, { kind = 'scrape', retryable = true } = {}) {
    super(message)
    this.name = 'ScrapeError'
    this.kind = kind // 'load' | 'structure' | 'store' | 'timeout' | 'validation' | 'option' | 'scrape'
    this.retryable = retryable
  }
}

const CONSENT_WINDOW_MS = 5500 // the popup appears 1.5-5s after the app mounts
const PRICE_LOAD_TIMEOUT_MS = 60_000 // covers the store's own 6 retries + slow responses
const ATTEMPT_TIMEOUT_MS = 120_000 // hard ceiling for one attempt, whatever happens
const MAX_CHECK_AGAIN = 3 // re-requests while the quote is still "Refreshing prices"

/**
 * Scrape one product option, retrying with a fresh browser context on failure.
 * Never throws for scrape problems: returns { ok: false, ... } so the caller can log it honestly.
 *
 * @param {import('playwright').Browser} browser
 * @param {{ storeProductId:number, optionId:string, name?:string }} target
 * @param {{ maxAttempts?:number, log?:(msg:string)=>void, faults?:object, overlay?:boolean }} options
 */
export async function scrapeWithRetries(browser, target, { maxAttempts = 3, log = console.log, faults = null, overlay = false } = {}) {
  const errors = []
  const notes = []
  const startedAt = Date.now()
  const faultState = faults ? { ...faults, used: {} } : null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    })
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ScrapeError(`attempt took longer than ${ATTEMPT_TIMEOUT_MS / 1000}s`, { kind: 'timeout' }))
          context.close().catch(() => {}) // aborts whatever Playwright was waiting on
        }, ATTEMPT_TIMEOUT_MS)
      })
      const result = await Promise.race([
        scrapeOnce(context, target, { attempt, maxAttempts, log, faultState, overlay, notes }),
        timeout,
      ])
      return { ok: true, ...result, attempts: attempt, errors, notes, durationMs: Date.now() - startedAt }
    } catch (err) {
      const message = err instanceof ScrapeError || err instanceof ParseError ? err.message : `unexpected: ${err.message}`
      errors.push(`attempt ${attempt}: ${message}`)
      log(`  ✗ attempt ${attempt}/${maxAttempts} failed: ${message}`)
      const retryable = err.retryable !== false
      if (!retryable || attempt === maxAttempts) {
        return { ok: false, attempts: attempt, errors, notes, error: errors.join(' | '), durationMs: Date.now() - startedAt }
      }
      const wait = 3000 * attempt
      log(`  ↻ retrying with a fresh browser page in ${wait / 1000}s`)
      await sleep(wait)
    } finally {
      clearTimeout(timer)
      await context.close().catch(() => {})
    }
  }
}

async function scrapeOnce(context, target, { attempt, maxAttempts, log, faultState, overlay, notes }) {
  const id = target.storeProductId
  const url = `${config.storeBaseUrl}/item/${id}`
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)

  const status = async (message) => {
    log(`  • ${message}`)
    if (overlay) await showOverlay(page, `Attempt ${attempt}/${maxAttempts} · ${message}`)
  }

  // ---- watch the page's own network traffic (what it loaded, and what it asked for) ----
  const net = { manifest: null, manifestStatus: null, item: null, quotes: [], handshakes: 0, errors: [] }
  page.on('response', async (res) => {
    let path
    try {
      path = new URL(res.url()).pathname
    } catch {
      return
    }
    if (!path.startsWith('/api/v2/')) return
    const s = res.status()
    if (s >= 400) net.errors.push(`${res.request().method()} ${path} -> ${s}`)
    if (path === '/api/v2/ui/manifest') {
      net.manifestStatus = s
      if (res.ok()) net.manifest = await res.json().catch(() => null)
    } else if (path === `/api/v2/items/${id}` && res.ok()) {
      net.item = await res.json().catch(() => null)
    } else if (path === `/api/v2/items/${id}/quote`) {
      net.quotes.push({ opt: new URL(res.url()).searchParams.get('opt'), status: s })
    }
  })
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/v2/handshake')) net.handshakes++
  })

  if (faultState) await installFaults(context, faultState, attempt, log)

  // ---- trap 3: cookie popup. Auto-dismiss whenever it blocks a click. ----
  const scrim = page.locator('.consent-scrim')
  const dismissConsent = async () => {
    for (let i = 0; i < 5 && (await scrim.isVisible()); i++) {
      await scrim.getByRole('button', { name: /reject/i }).click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(200)
    }
    if (await scrim.isVisible()) throw new ScrapeError('cookie popup would not close', { kind: 'structure' })
  }
  await page.addLocatorHandler(scrim, dismissConsent)

  // ---- load the product page ----
  await status(`opening ${url}`)
  const openedAt = Date.now()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (err) {
    throw new ScrapeError(`page did not load: ${err.message.split('\n')[0]}`, { kind: 'load' })
  }
  const heading = page.locator('.pdp h1, .pdp .shelf-alert').first()
  await heading.waitFor({ timeout: 20_000 }).catch(() => {
    throw new ScrapeError('product did not render within 20s', { kind: 'load' })
  })
  if (await page.locator('.pdp .shelf-alert').isVisible()) {
    const text = (await page.locator('.pdp .shelf-alert').textContent())?.trim()
    throw new ScrapeError(`store could not load the product: ${text}`, { kind: 'store' })
  }

  // Make sure we are on the right product (guards against redirects or a shifted page).
  // (The heading can render a moment before our listener has finished reading the JSON.)
  await waitUntil(() => net.item, 5000)
  if (!net.item || net.item.id !== id) throw new ScrapeError(`page is not product ${id}`, { kind: 'structure' })
  const h1 = (await page.locator('.pdp h1').textContent())?.trim()
  if (h1 !== net.item.name) throw new ScrapeError(`heading "${h1}" does not match product name`, { kind: 'structure' })

  // ---- trap 7: layout manifest. Use the exact one the page loaded. ----
  await waitUntil(() => net.manifest || (net.manifestStatus && net.manifestStatus >= 400), 10_000)
  if (!net.manifest?.classes?.priceValue) {
    throw new ScrapeError(`layout manifest did not load (HTTP ${net.manifestStatus ?? 'no response'})`, { kind: 'load' })
  }
  const cls = net.manifest.classes
  await status(`layout variant ${net.manifest.variant} (price class .${cls.priceValue})`)

  // ---- trap 1: random default option. Select ours by the store's own option id. ----
  const option = net.item.options?.find((o) => o.id === target.optionId)
  if (!option) {
    throw new ScrapeError(`option ${target.optionId} is no longer offered for this product`, { kind: 'option', retryable: false })
  }
  const hasPicker = net.item.options.length > 1
  if (hasPicker) {
    await status(`selecting option "${option.label}"`)
    const chip = page.locator('.opt-picker button.opt-chip').filter({ hasText: new RegExp(`^${escapeRegex(option.label)}$`) })
    for (let i = 0; i < 3 && (await chip.getAttribute('aria-pressed')) !== 'true'; i++) {
      await chip.click()
      await page.waitForTimeout(150)
    }
    if ((await chip.getAttribute('aria-pressed')) !== 'true') {
      throw new ScrapeError(`could not select option "${option.label}"`, { kind: 'structure' })
    }
  }

  // ---- trap 3 (again): let the popup's window pass, then clear it before moving the mouse ----
  const wait = openedAt + CONSENT_WINDOW_MS - Date.now()
  if (wait > 0) {
    await status(`waiting ${(wait / 1000).toFixed(1)}s for the cookie popup window`)
    await page.waitForTimeout(wait)
  }
  if (await scrim.isVisible()) await status('dismissing cookie popup')
  await dismissConsent()

  // ---- trap 4: interaction gate ----
  const panel = page.locator('.offer-panel')
  const checkButton = panel.getByRole('button', { name: /check today/i })
  await status('moving the mouse over the price area (interaction gate)')
  let unlocked = false
  for (let round = 0; round < 3 && !unlocked; round++) {
    await dismissConsent()
    const box = await panel.boundingBox()
    if (!box) throw new ScrapeError('price panel not found', { kind: 'structure' })
    for (let i = 0; i < 14; i++) {
      const x = box.x + 20 + ((box.width - 40) * i) / 13
      const y = box.y + box.height / 2 + Math.sin(i) * (box.height / 4)
      await page.mouse.move(x, y, { steps: 2 })
      await page.waitForTimeout(60) // the page samples moves at most every 40ms
    }
    await page.waitForTimeout(700) // required dwell time is 600ms
    unlocked = await checkButton.isEnabled()
  }
  if (!unlocked) throw new ScrapeError('price button stayed disabled after mouse movement', { kind: 'structure' })

  // ---- trap 2: dropped clicks ----
  await status('clicking "Check today’s price"')
  await clickUntilPageReacts(page, checkButton, 'locked', notes, status)

  // ---- trap 11: slow / failing responses (the page retries up to 6 times itself) ----
  await status('waiting for the price to load')
  await waitForQuote(page, net)

  // ---- trap 9: stale "Refreshing prices" quotes are never used ----
  let pageRetries = 0
  let snapshot = await readQuote(page, cls)
  pageRetries += snapshot.storeAttempts - 1
  for (let i = 0; snapshot.pending && i < MAX_CHECK_AGAIN; i++) {
    await status('price is still "Refreshing" (stale), requesting a fresh quote')
    notes.push(`quote was marked "Refreshing prices" (stale value ${snapshot.priceText?.replace(/[​ ]/g, '')}); not stored, re-requested`)
    const again = panel.getByRole('button', { name: /check again/i })
    await page.waitForTimeout(1500)
    await clickUntilPageReacts(page, again, 'ready', notes, status)
    await waitForQuote(page, net)
    snapshot = await readQuote(page, cls)
    pageRetries += 1 + (snapshot.storeAttempts - 1)
  }
  if (snapshot.pending) throw new ScrapeError('price stayed in "Refreshing prices" state', { kind: 'validation' })
  if (snapshot.storeAttempts > 1) notes.push(`store needed ${snapshot.storeAttempts} tries to load the price`)

  // ---- traps 5/6: decoys and look-alikes. Exactly one real price element, confirmed twice. ----
  if (snapshot.priceCount !== 1) {
    throw new ScrapeError(`expected exactly 1 price element (.${cls.priceValue}), found ${snapshot.priceCount}`, { kind: 'structure' })
  }
  if (!snapshot.priceVisible) throw new ScrapeError('the price element is hidden (decoy?)', { kind: 'structure' })
  if (!snapshot.crossCheckAgrees) {
    throw new ScrapeError(
      `page structure changed: ${snapshot.candidateCount} visible price candidates, manifest element not the single one`,
      { kind: 'structure' },
    )
  }

  // ---- verify the quote is for OUR option (UI state and the actual network request) ----
  if (hasPicker && snapshot.selectedOption !== option.label) {
    throw new ScrapeError(`selected option changed to "${snapshot.selectedOption}"`, { kind: 'validation' })
  }
  const lastQuote = net.quotes.at(-1)
  if (!lastQuote || lastQuote.opt !== target.optionId || lastQuote.status !== 200) {
    throw new ScrapeError(`last quote request was for ${lastQuote?.opt ?? 'nothing'} (HTTP ${lastQuote?.status}), expected ${target.optionId}`, { kind: 'validation' })
  }

  // ---- traps 8 & 10: parse strictly, then sanity-check ----
  const price = parsePrice(snapshot.priceText)
  const stock = parseStock(snapshot.stockText)
  let mrp = null
  try {
    mrp = snapshot.mrpText ? parsePrice(snapshot.mrpText).value : null
  } catch {
    notes.push(`could not parse MRP "${snapshot.mrpText}" (not stored)`)
  }
  if (!(price.value > 0 && price.value < 100_000_000)) throw new ScrapeError(`implausible price ${price.value}`, { kind: 'validation' })
  if (mrp !== null && price.value > mrp) throw new ScrapeError(`price ${price.value} is above MRP ${mrp}`, { kind: 'validation' })
  if (snapshot.soldOutPill !== (stock.value === 0)) {
    throw new ScrapeError(`stock "${snapshot.stockText}" disagrees with the availability badge`, { kind: 'validation' })
  }
  if (!stock.recognised) notes.push(`new stock wording seen: "${snapshot.stockText}"`)

  await status(`✓ price ₹${price.value.toLocaleString('en-IN')} · stock ${stock.value}`)
  if (overlay) await page.waitForTimeout(1500) // leave the result on screen for the recording

  return {
    price: price.value,
    currency: price.currency ?? 'INR',
    stock: stock.value,
    mrp,
    rawPriceText: snapshot.priceText,
    layoutVariant: net.manifest.variant ?? null,
    pageRetries,
    extra: {
      memberPrice: safeParse(snapshot.saleText?.replace(/member price/i, '')),
      badge: cleanText(snapshot.badgeText),
      rating: cleanText(snapshot.ratingText),
      seller: cleanText(snapshot.sellerText),
      delivery: cleanText(snapshot.deliveryText),
      stockText: cleanText(snapshot.stockText),
      storeNetworkErrors: net.errors.length ? net.errors : undefined,
    },
  }
}

// Click, then confirm the page actually reacted; the store silently drops ~17% of clicks
// and delays another ~17% by 0.9s. 'locked' = first click, 'ready' = "Check again".
async function clickUntilPageReacts(page, button, fromState, notes, status) {
  const fromClass = fromState === 'locked' ? 'offer-locked' : 'offer-ready'
  for (let click = 1; click <= 4; click++) {
    await button.click()
    const reacted = await page
      .waitForFunction((c) => !document.querySelector('.offer-panel')?.classList.contains(c), fromClass, { timeout: 2500 })
      .then(() => true, () => false)
    if (reacted) return
    notes.push(`click ${click} was ignored by the page`)
    await status(`click ${click} was ignored by the page, clicking again`)
  }
  throw new ScrapeError('the page ignored 4 clicks in a row', { kind: 'structure' })
}

async function waitForQuote(page, net) {
  const done = await page
    .waitForFunction(
      () => {
        const p = document.querySelector('.offer-panel')
        return p && (p.classList.contains('offer-ready') || p.classList.contains('offer-failed'))
      },
      null,
      { timeout: PRICE_LOAD_TIMEOUT_MS },
    )
    .then(() => true, () => false)
  const errors = net.errors.length ? ` (store errors: ${summarise(net.errors)})` : ''
  if (!done) throw new ScrapeError(`price did not load within ${PRICE_LOAD_TIMEOUT_MS / 1000}s${errors}`, { kind: 'timeout' })
  if (await page.locator('.offer-panel.offer-failed').isVisible()) {
    const text = (await page.locator('.offer-panel.offer-failed').innerText()).replace(/\s+/g, ' ').replace(/retry$/i, '').trim()
    throw new ScrapeError(`store gave up: ${text}${errors}`, { kind: 'store' })
  }
}

// Reads everything we need from the rendered quote in ONE pass inside the page.
function readQuote(page, cls) {
  return page.evaluate((cls) => {
    const panel = document.querySelector('.offer-panel.offer-ready')
    const row = panel?.querySelector('.offer-row')
    const sel = (c) => (c ? `.${CSS.escape(c)}` : null)
    const visible = (el) => {
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && el.getClientRects().length > 0
    }
    const text = (root, c) => (c && root?.querySelector(sel(c))?.textContent) ?? null

    const priceEls = row ? [...row.querySelectorAll(sel(cls.priceValue))] : []
    const priceEl = priceEls[0] ?? null

    // Second, independent method: the only visible child of the price row that is not
    // the struck-through MRP, the member price, the % badge or a status label.
    const candidates = row
      ? [...row.children].filter(
          (el) =>
            visible(el) &&
            !getComputedStyle(el).textDecorationLine.includes('line-through') &&
            !/member price|% saving|refreshing prices/i.test(el.textContent),
        )
      : []

    const foot = panel?.querySelector('.offer-foot span')?.textContent ?? ''
    const attemptsMatch = foot.match(/Loaded in (\d+) attempt/)
    const seller = cls.seller ? panel?.querySelector(sel(cls.seller)) : null

    return {
      priceCount: priceEls.length,
      priceVisible: priceEl ? visible(priceEl) : false,
      priceText: priceEl?.textContent ?? null,
      crossCheckAgrees: candidates.length === 1 && candidates[0] === priceEl,
      candidateCount: candidates.length,
      pending: !!row && (/refreshing prices/i.test(row.textContent) || (priceEl && Number(getComputedStyle(priceEl).opacity) < 0.9)),
      storeAttempts: attemptsMatch ? Number(attemptsMatch[1]) : 1,
      mrpText: text(row, cls.mrp),
      saleText: text(row, cls.sale),
      badgeText: text(row, cls.badge),
      stockText: text(panel, cls.stock),
      soldOutPill: !!panel?.querySelector('.avail-no'),
      ratingText: text(panel, cls.rating)?.replace(/★/g, '') ?? null,
      sellerText: seller?.getAttribute('title') || seller?.textContent?.replace(/^Seller:\s*/, '') || null,
      deliveryText: text(panel, cls.delivery),
      selectedOption: document.querySelector('.opt-chip[aria-pressed="true"]')?.textContent ?? null,
    }
  }, cls)
}

// ---------------------------------------------------------------------------
// Headed-mode helpers
// ---------------------------------------------------------------------------
async function showOverlay(page, message) {
  await page
    .evaluate((msg) => {
      let el = document.getElementById('__scraper_status')
      if (!el) {
        el = document.createElement('div')
        el.id = '__scraper_status'
        el.style.cssText =
          'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:560px;padding:10px 14px;' +
          'background:rgba(20,20,30,.92);color:#fff;font:14px/1.4 system-ui,sans-serif;border-radius:8px;' +
          'pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.3)'
        document.body.appendChild(el)
      }
      el.textContent = `🤖 Scraper · ${msg}`
    }, message)
    .catch(() => {})
}

// Simulated faults, used only by the headed demo (--chaos) to show the retry logic on video.
async function installFaults(context, state, attempt, log) {
  const once = (key) => !state.used[key] && (state.used[key] = true)
  if (state.failManifestOnFirstAttempt && attempt === 1) {
    await context.route('**/api/v2/ui/manifest', (route) => {
      log('  ⚡ [simulated fault] layout manifest -> HTTP 503')
      route.fulfill({ status: 503, body: 'Service Unavailable' })
    })
  }
  if (state.slowHandshakeMs) {
    await context.route('**/api/v2/handshake', async (route) => {
      if (route.request().method() === 'GET' && once(`slow-${attempt}`)) {
        log(`  ⚡ [simulated fault] delaying handshake by ${state.slowHandshakeMs / 1000}s (slow response)`)
        await sleep(state.slowHandshakeMs)
      }
      route.continue()
    })
  }
  if (state.failQuotes) {
    await context.route('**/api/v2/items/*/quote*', (route) => {
      state.used.quoteFailures = (state.used.quoteFailures ?? 0) + 1
      if (state.used.quoteFailures <= state.failQuotes) {
        log(`  ⚡ [simulated fault] price quote -> HTTP 503 (${state.used.quoteFailures}/${state.failQuotes})`)
        return route.fulfill({ status: 503, body: 'upstream error' })
      }
      route.continue()
    })
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
async function waitUntil(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (!predicate() && Date.now() < end) await sleep(100)
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ["GET /x -> 503", "GET /x -> 503"] -> "GET /x -> 503 ×2"
function summarise(lines) {
  const counts = new Map()
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1)
  return [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ')
}

// Display text for the dashboard: drop the invisible characters the store hides inside words.
function cleanText(text) {
  const s = text?.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '').replace(/\s+/g, ' ').trim()
  return s || null
}

function safeParse(text) {
  try {
    return text ? parsePrice(text.trim()).value : null
  } catch {
    return null
  }
}
