import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import healthRouter from './routes/health.js'
import catalogRouter from './routes/catalog.js'
import { ensureCatalogFresh } from './scraper/catalog.js'

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

// Routes added in later steps:
//   /api/tracked   add / list / remove tracked products, history and scrape log
//   /api/export    CSV download of every scrape attempt
//   /api/cron      endpoint cron-job.org calls every 2 hours

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Express 5 forwards errors from async handlers here automatically.
app.use((err, _req, res, _next) => {
  console.error('[api] error:', err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`)
  // Fill or refresh the search catalog in the background; the API is usable meanwhile.
  ensureCatalogFresh().catch((err) => console.error('[catalog] freshness check failed:', err.message))
})
