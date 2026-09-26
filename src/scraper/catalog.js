import { config } from '../config.js'
import { query } from '../db/pool.js'
import { fetchStoreJson, StoreHttpError } from './http.js'

// Catalog = the list of products in the store, used for search.
// Everything here is plain HTTP + JSON; no browser is needed for the catalog.
//
// Why a "sync" instead of calling the store on every search:
//   - the store has no search endpoint (?q= is ignored)
//   - /api/v2/listings returns a NEW random order on every request, so walking
//     pages 1..16 once only finds ~65% of products
// So we collect the whole catalog into our own table and search that with SQL.

const PAGE_SIZE = 60 // the store caps limit at 60
const MAX_LISTING_REQUESTS = 400 // hard stop so a misbehaving store can't keep us looping forever
const GAP_FILL_THRESHOLD = 0.05 // when <=5% are missing, fetch the missing ids directly
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Response validation: never trust the store's JSON blindly.
// ---------------------------------------------------------------------------
function validateListing(data) {
  if (!data || !Array.isArray(data.results)) throw new Error('listing has no results array')
  if (!Number.isInteger(data.count) || data.count <= 0) throw new Error('listing has no valid count')
  for (const p of data.results) validateProductBasics(p)
}

function validateProductBasics(p) {
  if (!p || !Number.isInteger(p.id)) throw new Error('product without an integer id')
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`product ${p.id} has no name`)
}

function validateItem(expectedId) {
  return (data) => {
    validateProductBasics(data)
    if (data.id !== expectedId) throw new Error(`asked for item ${expectedId}, got ${data.id}`)
    if (!Array.isArray(data.options) || data.options.length === 0) throw new Error('item has no options')
    for (const o of data.options) {
      if (typeof o?.id !== 'string' || typeof o?.label !== 'string') throw new Error('malformed option')
    }
  }
}

// ---------------------------------------------------------------------------
// Database writes
// ---------------------------------------------------------------------------
async function upsertProducts(products) {
  if (products.length === 0) return
  // unnest() turns parallel arrays into rows, so a whole page is saved in ONE query.
  await query(
    `INSERT INTO catalog_products (store_product_id, slug, name, brand, category, sku, description, synced_at)
     SELECT *, now() FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
     ON CONFLICT (store_product_id) DO UPDATE SET
       slug = EXCLUDED.slug, name = EXCLUDED.name, brand = EXCLUDED.brand, category = EXCLUDED.category,
       sku = EXCLUDED.sku, description = EXCLUDED.description, synced_at = EXCLUDED.synced_at`,
    [
      products.map((p) => p.id),
      products.map((p) => p.slug ?? null),
      products.map((p) => p.name.trim()),
      products.map((p) => p.brand ?? null),
      products.map((p) => p.category ?? null),
      products.map((p) => p.sku ?? null),
      products.map((p) => p.description ?? null),
    ],
  )
}

// ---------------------------------------------------------------------------
// The sync algorithm
// ---------------------------------------------------------------------------
/**
 * Collect every product in the store into catalog_products.
 *
 * Phase 1 (sampling): request listing pages repeatedly. Each response is a random
 *   sample, so the number of unique products grows quickly at first, then slowly.
 * Phase 2 (gap fill): once <=5% are missing, if the ids we have form a contiguous
 *   range whose size equals the store's count, the missing ones are exactly the gaps
 *   in that range, so we fetch those items directly by id instead of waiting for
 *   luck. If the range isn't contiguous, we just keep sampling.
 */
export async function syncCatalog({ log = console.log } = {}) {
  const startedAt = Date.now()
  const { rows: [{ now: syncStartedAt }] } = await query('SELECT now()')

  const seen = new Map() // id -> product
  let expected = null
  let listingRequests = 0
  let itemRequests = 0
  let gapFillUsed = false

  const missing = () => (expected ?? Infinity) - seen.size

  // Phase 1: sampling
  let consecutiveFailures = 0
  while (listingRequests < MAX_LISTING_REQUESTS) {
    const page = (listingRequests % 16) + 1
    listingRequests++
    let data
    try {
      ;({ data } = await fetchStoreJson(`/api/v2/listings?page=${page}&limit=${PAGE_SIZE}`, { validate: validateListing }))
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      log(`[catalog] listing request failed after retries: ${err.message} (${consecutiveFailures} in a row)`)
      if (consecutiveFailures >= 5) {
        log('[catalog] store looks down; stopping this sync early (catalog kept as-is)')
        break
      }
      continue
    }
    expected = data.count
    const fresh = data.results.filter((p) => !seen.has(p.id))
    fresh.forEach((p) => seen.set(p.id, p))
    await upsertProducts(fresh)

    if (listingRequests % 10 === 0) log(`[catalog] ${listingRequests} listing requests -> ${seen.size}/${expected}`)
    if (missing() <= 0) break
    if (missing() <= Math.ceil(expected * GAP_FILL_THRESHOLD) && rangeIsContiguousWithGaps(seen, expected)) break
  }

  // Phase 2: gap fill
  if (expected !== null && missing() > 0 && rangeIsContiguousWithGaps(seen, expected)) {
    gapFillUsed = true
    const ids = [...seen.keys()]
    const [min, max] = [Math.min(...ids), Math.max(...ids)]
    const gaps = []
    for (let id = min; id <= max; id++) if (!seen.has(id)) gaps.push(id)
    log(`[catalog] gap fill: fetching ${gaps.length} missing ids directly`)
    for (const id of gaps) {
      itemRequests++
      try {
        const { data } = await fetchStoreJson(`/api/v2/items/${id}`, { validate: validateItem(id) })
        seen.set(id, data)
        await upsertProducts([data])
      } catch (err) {
        log(`[catalog] item ${id} failed: ${err.message}`)
      }
    }
  }

  const complete = expected !== null && seen.size >= expected
  // Only remove products that vanished from the store when we KNOW we saw everything.
  let removed = 0
  if (complete) {
    const res = await query('DELETE FROM catalog_products WHERE synced_at < $1', [syncStartedAt])
    removed = res.rowCount
  }

  const result = {
    complete,
    collected: seen.size,
    expected,
    listingRequests,
    itemRequests,
    gapFillUsed,
    removed,
    durationMs: Date.now() - startedAt,
  }
  log(`[catalog] sync finished: ${JSON.stringify(result)}`)
  return result
}

// True when the ids we've seen fit inside a range whose size equals the store's count.
// Then the unseen ids in that range are exactly the missing products.
function rangeIsContiguousWithGaps(seen, expected) {
  if (seen.size === 0) return false
  const ids = [...seen.keys()]
  return Math.max(...ids) - Math.min(...ids) + 1 === expected
}

// ---------------------------------------------------------------------------
// Background sync state (one sync at a time per process)
// ---------------------------------------------------------------------------
const syncState = { running: false, startedAt: null, lastResult: null, lastError: null }

export function startBackgroundSync(reason) {
  if (syncState.running) return false
  syncState.running = true
  syncState.startedAt = new Date().toISOString()
  console.log(`[catalog] background sync started (${reason})`)
  syncCatalog()
    .then((result) => {
      syncState.lastResult = result
      syncState.lastError = null
    })
    .catch((err) => {
      syncState.lastError = err.message
      console.error('[catalog] background sync crashed:', err)
    })
    .finally(() => {
      syncState.running = false
    })
  return true
}

export async function getCatalogStatus() {
  const { rows: [row] } = await query(
    'SELECT count(*)::int AS count, max(synced_at) AS last_synced_at FROM catalog_products',
  )
  return {
    count: row.count,
    lastSyncedAt: row.last_synced_at,
    syncing: syncState.running,
    lastResult: syncState.lastResult,
    lastError: syncState.lastError,
  }
}

// Called when the server starts: sync if the catalog is empty or older than 24h.
// Render restarts the server after it sleeps, so this also keeps the catalog fresh.
export async function ensureCatalogFresh() {
  const { count, lastSyncedAt } = await getCatalogStatus()
  const stale = !lastSyncedAt || Date.now() - new Date(lastSyncedAt).getTime() > STALE_AFTER_MS
  if (count === 0 || stale) startBackgroundSync(count === 0 ? 'catalog empty' : 'catalog older than 24h')
}

// ---------------------------------------------------------------------------
// Search (our own, against catalog_products)
// ---------------------------------------------------------------------------
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * Partial or full name search. Every word must appear in the name, in any order:
 * "scan nano" finds "Tamarack Film Scanner Nano". A number also matches the product id.
 * Ranking: exact name, then names starting with the query, then the rest (A-Z).
 */
export async function searchCatalog(rawQuery, limit = 20) {
  const q = String(rawQuery ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
  if (!q) return []
  const patterns = q.split(' ').map((word) => `%${escapeLike(word)}%`)
  const asId = /^\d+$/.test(q) ? Number(q) : null

  const { rows } = await query(
    `SELECT store_product_id, name, brand, category, sku
       FROM catalog_products
      WHERE name ILIKE ALL($1::text[]) OR store_product_id = $2
      ORDER BY (store_product_id = $2) DESC NULLS LAST,
               (lower(name) = lower($3)) DESC,
               (lower(name) LIKE lower($4)) DESC,
               name
      LIMIT $5`,
    [patterns, asId, q, `${escapeLike(q)}%`, Math.min(Math.max(Number(limit) || 20, 1), 50)],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Product details (live from the store, cached briefly)
// ---------------------------------------------------------------------------
const DETAILS_TTL_MS = 10 * 60 * 1000
const detailsCache = new Map() // id -> { at, value }

export class ProductNotFoundError extends Error {}

export async function getProductDetails(id) {
  const cached = detailsCache.get(id)
  if (cached && Date.now() - cached.at < DETAILS_TTL_MS) return cached.value

  let data
  try {
    ;({ data } = await fetchStoreJson(`/api/v2/items/${id}`, { validate: validateItem(id) }))
  } catch (err) {
    if (err instanceof StoreHttpError && err.status === 404) throw new ProductNotFoundError(`Product ${id} not found`)
    throw err
  }

  const reviews = Array.isArray(data.reviews) ? data.reviews : []
  const value = {
    store_product_id: data.id,
    name: data.name,
    brand: data.brand ?? null,
    category: data.category ?? null,
    sku: data.sku ?? null,
    description: data.description ?? null,
    specs: data.specs ?? null,
    option_axis: data.optionAxis ?? null,
    options: data.options.map((o) => ({ id: o.id, label: o.label })),
    review_count: reviews.length,
    review_avg: reviews.length
      ? Math.round((reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length) * 10) / 10
      : null,
    product_url: `${config.storeBaseUrl}/item/${data.id}`,
  }
  detailsCache.set(id, { at: Date.now(), value })
  return value
}
