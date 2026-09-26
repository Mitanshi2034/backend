// Runs a full catalog sync in the foreground and prints progress.
// Usage: npm run catalog:sync
import { syncCatalog } from '../src/scraper/catalog.js'
import { pool } from '../src/db/pool.js'

try {
  const result = await syncCatalog()
  if (!result.complete) process.exitCode = 1
} catch (err) {
  console.error('Catalog sync failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
