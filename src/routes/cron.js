import { Router } from 'express'
import { requireSecret } from '../middleware/requireSecret.js'
import { RunInProgressError, startRunInBackground } from '../scraper/runner.js'

const router = Router()

// POST /api/cron/scrape   (header: x-cron-secret)
// Called by cron-job.org every 2 hours. Opens a run, answers immediately (cron-job.org
// gives up after ~30s, a run takes ~15s per product), and scrapes in the background.
router.post('/scrape', requireSecret, async (_req, res) => {
  try {
    const run = await startRunInBackground('cron')
    res.status(202).json({ started: true, run_id: run.id })
  } catch (err) {
    // Not an error from the scheduler's point of view: the previous run is still going.
    if (err instanceof RunInProgressError) return res.status(200).json({ started: false, reason: err.message })
    throw err
  }
})

export default router
