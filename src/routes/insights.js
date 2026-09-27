import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()

// GET /api/attempts?limit=200&outcome=failed&tracked_id=3
// Every scrape attempt across all products (the global scrape log), newest first.
router.get('/attempts', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000)
  const outcome = ['success', 'retried', 'failed'].includes(req.query.outcome) ? req.query.outcome : null
  const trackedId = Number(req.query.tracked_id) || null
  const { rows } = await query(
    `SELECT a.id, a.tracked_product_id, t.store_product_id, t.name, t.option_label, a.run_id, a.attempted_at,
            a.outcome, a.price, a.stock, a.attempts, a.page_retries, a.duration_ms, a.error, a.trigger
       FROM scrape_attempts a JOIN tracked_products t ON t.id = a.tracked_product_id
      WHERE ($1::text IS NULL OR a.outcome = $1) AND ($2::bigint IS NULL OR a.tracked_product_id = $2)
      ORDER BY a.attempted_at DESC LIMIT $3`,
    [outcome, trackedId, limit],
  )
  res.json(rows)
})

// GET /api/changes?limit=30
// Notable changes between consecutive successful checks of the same product (the "alerts" feed):
// price drops / rises, back in stock, sold out; plus layout changes the scraper detected on the store
// (manifest variant switched) and checks that failed because the page structure looked different.
router.get('/changes', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200)
  const { rows } = await query(
    `WITH ok AS (
       SELECT a.*, t.name, t.option_label,
              lag(a.price) OVER w AS prev_price, lag(a.stock) OVER w AS prev_stock,
              lag(a.layout_variant) OVER w AS prev_variant
         FROM scrape_attempts a JOIN tracked_products t ON t.id = a.tracked_product_id
        WHERE a.outcome <> 'failed'
       WINDOW w AS (PARTITION BY a.tracked_product_id ORDER BY a.attempted_at)
     ), events AS (
       SELECT tracked_product_id, name, option_label, attempted_at,
              CASE WHEN price < prev_price THEN 'price_drop' ELSE 'price_rise' END AS kind,
              prev_price AS old_value, price AS new_value
         FROM ok WHERE prev_price IS NOT NULL AND price <> prev_price
       UNION ALL
       SELECT tracked_product_id, name, option_label, attempted_at,
              CASE WHEN prev_stock = 0 THEN 'back_in_stock' ELSE 'sold_out' END, prev_stock, stock
         FROM ok WHERE prev_stock IS NOT NULL AND (prev_stock = 0) <> (stock = 0)
       UNION ALL
       SELECT tracked_product_id, name, option_label, attempted_at, 'layout_changed', prev_variant, layout_variant
         FROM ok WHERE prev_variant IS NOT NULL AND layout_variant IS NOT NULL AND layout_variant <> prev_variant
       UNION ALL
       SELECT a.tracked_product_id, t.name, t.option_label, a.attempted_at, 'structure_changed', NULL, NULL
         FROM scrape_attempts a JOIN tracked_products t ON t.id = a.tracked_product_id
        WHERE a.outcome = 'failed' AND a.error ILIKE '%structure changed%'
     )
     SELECT * FROM events ORDER BY attempted_at DESC LIMIT $1`,
    [limit],
  )
  res.json(rows)
})

// GET /api/stats
// Numbers for the overview and status pages.
router.get('/stats', async (_req, res) => {
  const { rows: [s] } = await query(
    `SELECT (SELECT count(*)::int FROM tracked_products WHERE is_active) AS tracked_active,
            (SELECT count(*)::int FROM scrape_attempts WHERE attempted_at > now() - interval '24 hours') AS checks_24h,
            (SELECT count(*)::int FROM scrape_attempts WHERE attempted_at > now() - interval '24 hours' AND outcome <> 'failed') AS ok_24h,
            (SELECT count(*)::int FROM scrape_attempts) AS checks_total,
            (SELECT count(*)::int FROM scrape_attempts WHERE outcome <> 'failed') AS ok_total,
            (SELECT count(*)::int FROM scrape_runs WHERE trigger = 'cron') AS scheduled_runs,
            (SELECT max(started_at) FROM scrape_runs WHERE trigger = 'cron') AS last_scheduled_at,
            (SELECT min(attempted_at) FROM scrape_attempts) AS first_check_at,
            (SELECT round(avg(duration_ms))::int FROM scrape_attempts WHERE outcome <> 'failed'
                AND attempted_at > now() - interval '24 hours') AS avg_duration_ms_24h`,
  )
  res.json(s)
})

export default router
