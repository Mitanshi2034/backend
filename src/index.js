import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import healthRouter from './routes/health.js'
import catalogRouter from './routes/catalog.js'
import trackedRouter from './routes/tracked.js'
import runsRouter from './routes/runs.js'
import exportRouter from './routes/export.js'
import cronRouter from './routes/cron.js'
import { ensureCatalogFresh } from './scraper/catalog.js'
import { pool } from './db/pool.js'

const app = express()

app.use(
  cors({
    // Allow tools with no Origin header (curl, cron-job.org) and our listed frontends.
    // For any other origin we simply omit the CORS headers, so the browser blocks the response.
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
  }),
)
app.use(express.json())

app.get('/', (_req, res) => res.json({ name: 'INE Price Tracker API', health: '/api/health' }))
app.use('/api/health', healthRouter)
app.use('/api/catalog', catalogRouter)
app.use('/api/tracked', trackedRouter)
app.use('/api/runs', runsRouter)
app.use('/api/export', exportRouter)
app.use('/api/cron', cronRouter)

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Express 5 forwards errors from async handlers here automatically.
app.use((err, _req, res, _next) => {
  console.error('[api] error:', err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`)
  // Fill or refresh the search catalog in the background; the API is usable meanwhile.
  ensureCatalogFresh().catch((err) => console.error('[catalog] freshness check failed:', err.message))
})

// Render sends SIGTERM before stopping the instance (deploy, restart, free-tier sleep).
// Close any run in progress honestly right away, so it doesn't block the next scheduled run.
async function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`)
  server.close()
  try {
    const { rowCount } = await pool.query(
      `UPDATE scrape_runs SET status = 'abandoned', finished_at = now(),
              error = 'server was stopped during the run (deploy or restart)'
        WHERE status = 'running'`,
    )
    if (rowCount) console.log(`[server] marked ${rowCount} running run(s) as abandoned`)
    await pool.end()
  } catch (err) {
    console.error('[server] shutdown cleanup failed:', err.message)
  }
  process.exit(0)
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
