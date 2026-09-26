import { Router } from 'express'
import { requireSecret } from '../middleware/requireSecret.js'
import {
  getCatalogStatus,
  getProductDetails,
  ProductNotFoundError,
  searchCatalog,
  startBackgroundSync,
} from '../scraper/catalog.js'

const router = Router()

// GET /api/catalog/search?q=scanner&limit=20
// Partial or full name search against our copy of the catalog.
router.get('/search', async (req, res) => {
  const [results, catalog] = await Promise.all([searchCatalog(req.query.q, req.query.limit), getCatalogStatus()])
  res.json({
    query: String(req.query.q ?? ''),
    results,
    // lets the UI say "catalog still loading" instead of "no results" right after a fresh deploy
    catalog: { count: catalog.count, syncing: catalog.syncing },
  })
})

// GET /api/catalog/status
router.get('/status', async (_req, res) => {
  res.json(await getCatalogStatus())
})

// POST /api/catalog/sync   (header: x-cron-secret)
// Starts a catalog sync in the background and returns immediately.
router.post('/sync', requireSecret, (_req, res) => {
  const started = startBackgroundSync('manual request')
  res.status(202).json({ started, message: started ? 'Catalog sync started' : 'A sync is already running' })
})

// GET /api/catalog/products/:id
// Live product details from the store, including the options the user can pick from.
router.get('/products/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Product id must be a positive integer' })
  try {
    res.json(await getProductDetails(id))
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.message })
    // The store kept failing even after retries: say so honestly.
    res.status(502).json({ error: `Store did not respond correctly: ${err.message}` })
  }
})

export default router
