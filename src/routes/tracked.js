import { Router } from 'express'
import { query } from '../db/pool.js'
import { getProductDetails, ProductNotFoundError } from '../scraper/catalog.js'
import { RunInProgressError, startRunInBackground } from '../scraper/runner.js'

const router = Router()

const MAX_TRACKED = 15 // keeps one run short enough for a free-tier server
const MANUAL_COOLDOWN_MS = 2 * 60 * 1000

// Latest attempt + summary stats for each tracked product, in one query.
const LIST_SQL = `
  SELECT t.*,
         last.attempted_at AS last_attempt_at, last.outcome AS last_outcome, last.error AS last_error,
         ok.price AS last_price, ok.stock AS last_stock, ok.mrp AS last_mrp, ok.attempted_at AS last_success_at,
         ok.extra AS last_extra,
         stats.total_attempts, stats.failed_attempts, stats.retried_attempts, stats.min_price, stats.max_price,
         stats.avg_price, prev.price AS prev_price, prev.stock AS prev_stock, trend.points AS trend
    FROM tracked_products t
    LEFT JOIN LATERAL (
      SELECT attempted_at, outcome, error FROM scrape_attempts a
       WHERE a.tracked_product_id = t.id ORDER BY attempted_at DESC LIMIT 1
    ) last ON TRUE
    LEFT JOIN LATERAL (
      SELECT price, stock, mrp, attempted_at, extra FROM scrape_attempts a
       WHERE a.tracked_product_id = t.id AND outcome <> 'failed' ORDER BY attempted_at DESC LIMIT 1
    ) ok ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total_attempts,
             count(*) FILTER (WHERE outcome = 'failed')::int AS failed_attempts,
             count(*) FILTER (WHERE outcome = 'retried')::int AS retried_attempts,
             min(price) AS min_price, max(price) AS max_price, round(avg(price), 2) AS avg_price
        FROM scrape_attempts a WHERE a.tracked_product_id = t.id
    ) stats ON TRUE
    -- the successful check before the latest one (for "change since last check")
    LEFT JOIN LATERAL (
      SELECT price, stock FROM scrape_attempts a
       WHERE a.tracked_product_id = t.id AND outcome <> 'failed' ORDER BY attempted_at DESC OFFSET 1 LIMIT 1
    ) prev ON TRUE
    -- the last 24 checks, oldest first, for the card sparkline (failed checks included as gaps)
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('t', attempted_at, 'price', price, 'outcome', outcome) ORDER BY attempted_at) AS points
        FROM (SELECT attempted_at, price, outcome FROM scrape_attempts a
               WHERE a.tracked_product_id = t.id ORDER BY attempted_at DESC LIMIT 24) recent
    ) trend ON TRUE`

// GET /api/tracked
router.get('/', async (_req, res) => {
  const { rows } = await query(`${LIST_SQL} ORDER BY t.created_at`)
  res.json(rows)
})

// POST /api/tracked  { store_product_id, option_id }
// Validates against the live store, saves, and starts the first scrape right away.
router.post('/', async (req, res) => {
  const storeProductId = Number(req.body?.store_product_id)
  const optionId = String(req.body?.option_id ?? '')
  if (!Number.isInteger(storeProductId) || storeProductId <= 0 || !optionId) {
    return res.status(400).json({ error: 'store_product_id (integer) and option_id are required' })
  }

  let product
  try {
    product = await getProductDetails(storeProductId)
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.message })
    return res.status(502).json({ error: `Store did not respond correctly: ${err.message}` })
  }
  const option = product.options.find((o) => o.id === optionId)
  if (!option) return res.status(400).json({ error: `Option ${optionId} does not exist for this product` })

  const { rows: [{ count }] } = await query('SELECT count(*)::int AS count FROM tracked_products')
  if (count >= MAX_TRACKED) return res.status(400).json({ error: `You can track at most ${MAX_TRACKED} products` })

  let created
  try {
    ;({ rows: [created] } = await query(
      `INSERT INTO tracked_products (store_product_id, name, brand, category, sku, option_axis, option_id, option_label, product_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [product.store_product_id, product.name, product.brand, product.category, product.sku,
       product.option_axis, option.id, option.label, product.product_url],
    ))
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This product option is already being tracked' })
    throw err
  }

  // First data point immediately, instead of waiting up to 2 hours for the next cron.
  let firstScrape = 'started'
  try {
    await startRunInBackground('manual', { productIds: [created.id] })
  } catch (err) {
    if (!(err instanceof RunInProgressError)) throw err
    firstScrape = 'will be picked up by the run already in progress'
  }
  res.status(201).json({ ...created, first_scrape: firstScrape })
})

// PATCH /api/tracked/:id  { scrape_interval_minutes?, is_active? }
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { scrape_interval_minutes: interval, is_active: active } = req.body ?? {}
  if (interval !== undefined && !(Number.isInteger(interval) && interval >= 60 && interval <= 1440)) {
    return res.status(400).json({ error: 'scrape_interval_minutes must be an integer between 60 and 1440' })
  }
  if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false' })
  const { rows: [row] } = await query(
    `UPDATE tracked_products SET scrape_interval_minutes = COALESCE($2, scrape_interval_minutes),
            is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *`,
    [id, interval ?? null, active ?? null],
  )
  if (!row) return res.status(404).json({ error: 'Tracked product not found' })
  res.json(row)
})

// DELETE /api/tracked/:id  (also deletes its history, via ON DELETE CASCADE)
router.delete('/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM tracked_products WHERE id = $1', [Number(req.params.id)])
  if (!rowCount) return res.status(404).json({ error: 'Tracked product not found' })
  res.status(204).end()
})

// GET /api/tracked/:id/history?limit=500
// Every attempt (the scrape log). The price chart uses the rows whose outcome is not 'failed'.
router.get('/:id/history', async (req, res) => {
  const id = Number(req.params.id)
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000)
  const { rows: [product] } = await query(`${LIST_SQL} WHERE t.id = $1`, [id])
  if (!product) return res.status(404).json({ error: 'Tracked product not found' })
  const { rows: attempts } = await query(
    `SELECT id, run_id, attempted_at, outcome, price, stock, mrp, currency, attempts, page_retries,
            duration_ms, error, raw_price_text, layout_variant, trigger, extra
       FROM scrape_attempts WHERE tracked_product_id = $1 ORDER BY attempted_at DESC LIMIT $2`,
    [id, limit],
  )
  res.json({ product, attempts })
})

// POST /api/tracked/:id/scrape  (the dashboard's "Scrape now" button)
router.post('/:id/scrape', async (req, res) => {
  const id = Number(req.params.id)
  const { rows: [product] } = await query('SELECT id, last_scraped_at, is_active FROM tracked_products WHERE id = $1', [id])
  if (!product) return res.status(404).json({ error: 'Tracked product not found' })
  if (!product.is_active) return res.status(400).json({ error: 'Tracking is paused for this product' })
  if (product.last_scraped_at && Date.now() - new Date(product.last_scraped_at).getTime() < MANUAL_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Scraped less than 2 minutes ago; please wait a moment' })
  }
  try {
    const run = await startRunInBackground('manual', { productIds: [id] })
    res.status(202).json({ started: true, run_id: run.id })
  } catch (err) {
    if (err instanceof RunInProgressError) return res.status(409).json({ error: err.message })
    throw err
  }
})

export default router
