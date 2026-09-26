import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()

// GET /api/health
// Used by the frontend to show connection status, and by cron-job.org as a
// cheap "keep warm" ping so the Render instance is awake when a scrape is due.
router.get('/', async (_req, res) => {
  let database = 'ok'
  try {
    await query('SELECT 1')
  } catch (err) {
    database = `error: ${err.message}`
  }
  res.status(database === 'ok' ? 200 : 503).json({
    status: 'ok',
    database,
    time: new Date().toISOString(),
  })
})

export default router
