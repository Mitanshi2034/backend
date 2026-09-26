import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()

// GET /api/runs?limit=20
// Recent scrape runs: shows that the scheduler really fired, when, and how each run went.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200)
  const { rows } = await query('SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT $1', [limit])
  res.json(rows)
})

export default router
