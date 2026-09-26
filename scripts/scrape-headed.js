// Headed (visible browser) scraper run, for watching and recording the scraper.
//
// Usage (from the backend folder):
//   npm run scrape:headed                                 all active tracked products (dry run)
//   npm run scrape:headed -- --product 2565 --option o2   one specific product option (dry run)
//   npm run scrape:headed -- --product 2565 --option o2 --chaos
//        adds SIMULATED faults: layout request fails on attempt 1, a 5s slow response,
//        and two failed price requests, to show the retry logic on video
//   npm run scrape:headed -- --save                       store the results as a 'cli' run
//   --slow 150                                            slow every browser action by N ms (default 120)
//
// Dry runs never touch the database. Results of --chaos runs are never saved.
import { parseArgs } from 'node:util'
import { pool, query } from '../src/db/pool.js'
import { launchBrowser } from '../src/scraper/browser.js'
import { scrapeWithRetries } from '../src/scraper/price.js'
import { createRun, executeRun } from '../src/scraper/runner.js'

const { values: args } = parseArgs({
  options: {
    product: { type: 'string' },
    option: { type: 'string' },
    chaos: { type: 'boolean', default: false },
    save: { type: 'boolean', default: false },
    slow: { type: 'string', default: '120' },
    headless: { type: 'boolean', default: false }, // only for automated smoke tests of this script
  },
})

const slowMo = Number(args.slow) || 0
const faults = args.chaos ? { failManifestOnFirstAttempt: true, slowHandshakeMs: 5000, failQuotes: 2 } : null
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`)

try {
  if (args.save && args.chaos) throw new Error('--chaos uses simulated faults, so its results are never saved')

  if (args.save) {
    // Real, recorded run through the same code path the scheduler uses.
    let productIds
    if (args.product) {
      const { rows } = await query('SELECT id FROM tracked_products WHERE store_product_id = $1 AND ($2::text IS NULL OR option_id = $2)', [Number(args.product), args.option ?? null])
      if (!rows.length) throw new Error('That product option is not tracked yet; add it from the dashboard first')
      productIds = rows.map((r) => r.id)
    }
    const run = await createRun('cli')
    await executeRun(run, { productIds, force: true, headless: args.headless, slowMo, overlay: true, log })
  } else {
    // Dry run: scrape and print, nothing is written.
    let targets
    if (args.product) {
      if (!args.option) throw new Error('--option is required with --product (e.g. --option o2)')
      targets = [{ storeProductId: Number(args.product), optionId: args.option, label: `#${args.product}/${args.option}` }]
    } else {
      const { rows } = await query('SELECT * FROM tracked_products WHERE is_active ORDER BY id')
      if (!rows.length) throw new Error('No tracked products yet; use --product and --option')
      targets = rows.map((r) => ({ storeProductId: r.store_product_id, optionId: r.option_id, label: `${r.name} [${r.option_label}]` }))
    }
    log(`headed dry run${faults ? ' with SIMULATED faults' : ''}: ${targets.length} target(s)`)
    const browser = await launchBrowser({ headless: args.headless, slowMo })
    try {
      for (const t of targets) {
        log(`▶ ${t.label}`)
        const r = await scrapeWithRetries(browser, t, { log, faults, overlay: true })
        const outcome = !r.ok ? 'failed' : r.attempts === 1 && r.pageRetries === 0 ? 'success' : 'retried'
        log(`  RESULT: ${outcome.toUpperCase()}` + (r.ok ? ` · ₹${r.price} · stock ${r.stock}` : '') +
            ` · attempts ${r.attempts} · in-page retries ${r.pageRetries ?? 0} · ${(r.durationMs / 1000).toFixed(1)}s`)
        for (const line of [...r.errors, ...r.notes]) log(`    - ${line}`)
      }
    } finally {
      await browser.close()
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
