import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()

const COLUMNS = ['store_product_id', 'product_name', 'selected_option', 'timestamp', 'price', 'stock', 'outcome']

// Quote a CSV field when needed (RFC 4180), and neutralise values a spreadsheet would run as a formula.
function csvField(value) {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// GET /api/export/scrapes.csv
// One row per scrape attempt, oldest first. Failed attempts are included with empty price and stock.
router.get('/scrapes.csv', async (_req, res) => {
  const { rows } = await query(
    `SELECT t.store_product_id, t.name, t.option_label, a.attempted_at, a.price, a.stock, a.outcome
       FROM scrape_attempts a JOIN tracked_products t ON t.id = a.tracked_product_id
      ORDER BY a.attempted_at, a.id`,
  )
  const lines = [COLUMNS.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.store_product_id,
        r.name,
        r.option_label,
        new Date(r.attempted_at).toISOString(), // ISO 8601, UTC, e.g. 2026-09-26T14:00:03.512Z
        r.price === null ? '' : Number(r.price), // 22950 rather than "22950.00"
        r.stock ?? '',
        r.outcome,
      ]
        .map(csvField)
        .join(','),
    )
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="scrape-history-${stamp}.csv"`)
  res.send(`${lines.join('\r\n')}\r\n`)
})

export default router
