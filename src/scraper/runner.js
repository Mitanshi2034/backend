import { pool, query } from '../db/pool.js'
import { launchBrowser } from './browser.js'
import { sleep } from './http.js'
import { scrapeWithRetries } from './price.js'

// A "run" = one trigger (cron / manual button / CLI) that scrapes one or more tracked products.
//
// Guarantees:
//   - only one run at a time (unique index on scrape_runs WHERE status='running')
//   - products are scraped one by one with one shared browser (memory-friendly on Render)
//   - EVERY product in the run gets exactly one scrape_attempts row: success / retried / failed
//   - a crash in one product never stops the others; a crashed browser is relaunched
//   - the run row is always closed, even on unexpected errors

const ABANDON_AFTER_MINUTES = 30 // a 'running' row older than this belongs to a process that died
const DUE_TOLERANCE_MINUTES = 15 // cron fires every 120 min; a scrape at 10:00:30 is still due at 12:00:00
const PRODUCT_GAP_MS = 4_000 // polite pause between products, so a 10-product run doesn't hit the store back-to-back
const RATE_LIMIT_PAUSE_MS = 60_000 // after a product failed on 429s, let the store's limit reset before the next one
const SECOND_PASS_DELAY_MS = 120_000 // products that failed for temporary reasons get one more try after this

export class RunInProgressError extends Error {}

/**
 * Create the run row. Throws RunInProgressError if another run is active.
 * Split from executeRun() so the HTTP endpoint can answer immediately (cron-job.org times out at ~30s).
 */
export async function createRun(trigger) {
  // A run left 'running' by a crashed/restarted server would block everything forever; release it.
  await query(
    `UPDATE scrape_runs SET status = 'abandoned', finished_at = now(),
            error = 'server stopped before the run finished'
      WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
    [ABANDON_AFTER_MINUTES],
  )
  try {
    const {
      rows: [run],
    } = await query('INSERT INTO scrape_runs (trigger) VALUES ($1) RETURNING *', [trigger])
    return run
  } catch (err) {
    if (err.code === '23505') throw new RunInProgressError('Another scrape run is already in progress')
    throw err
  }
}

/**
 * Pick the products to scrape.
 * - productIds given (manual "scrape now"): exactly those, if active
 * - otherwise (cron): every active product whose interval has elapsed
 */
async function selectProducts({ productIds, force }) {
  if (productIds?.length) {
    const { rows } = await query(
      'SELECT * FROM tracked_products WHERE id = ANY($1::bigint[]) AND is_active ORDER BY id',
      [productIds],
    )
    return rows
  }
  const { rows } = await query(
    `SELECT * FROM tracked_products
      WHERE is_active
        AND ($1 OR last_scraped_at IS NULL
             OR last_scraped_at <= now() - make_interval(mins => scrape_interval_minutes - $2))
      ORDER BY last_scraped_at NULLS FIRST, id`,
    [Boolean(force), DUE_TOLERANCE_MINUTES],
  )
  return rows
}

/**
 * Execute a run that createRun() already opened.
 * @param {object} run  row returned by createRun
 * @param {{ productIds?: number[], force?: boolean, headless?: boolean, slowMo?: number,
 *           faults?: object, overlay?: boolean, log?: (m:string)=>void }} options
 */
export async function executeRun(run, options = {}) {
  const log = options.log ?? ((m) => console.log(`[run ${run.id}] ${m}`))
  let browser = null
  let succeeded = 0
  let failed = 0

  try {
    let queue = await selectProducts(options)
    const done = new Set()
    await query('UPDATE scrape_runs SET products_total = $2 WHERE id = $1', [run.id, queue.length])
    log(`${run.trigger} run: ${queue.length} product(s) to scrape`)

    const scrape = async (product, maxAttempts) => {
      try {
        if (!browser?.isConnected()) {
          if (browser) log('browser crashed; launching a new one')
          browser = await launchBrowser({ headless: options.headless, slowMo: options.slowMo })
        }
        return await scrapeWithRetries(
          browser,
          { storeProductId: product.store_product_id, optionId: product.option_id, name: product.name },
          {
            log,
            faults: options.faults,
            overlay: options.overlay,
            maxAttempts,
            rateLimitWaitsMs: options.rateLimitWaitsMs,
          },
        )
      } catch (err) {
        // Anything unexpected (e.g. the browser failed to launch) is still recorded as a failed attempt.
        return {
          ok: false,
          attempts: 1,
          errors: [`internal error: ${err.message}`],
          error: `internal error: ${err.message}`,
          notes: [],
          retryable: true,
        }
      }
    }
    const finish = async (product, label, result) => {
      await recordAttempt(product, run, result)
      if (result.ok) succeeded++
      else failed++
      log(result.ok ? `✓ ${label}: ₹${result.price} · stock ${result.stock}` : `✗ ${label}: ${result.error}`)
    }
    const labelOf = (p) => `${p.name} [${p.option_label}] (#${p.store_product_id}/${p.option_id})`

    // Pass 1. Failures that might be temporary (rate limit, timeout, store error) are held back for pass 2
    // instead of being recorded straight away; permanent ones (option removed) are recorded now.
    const deferred = []
    while (queue.length) {
      for (const product of queue) {
        if (done.size > 0) await sleep(options.productGapMs ?? PRODUCT_GAP_MS)
        done.add(product.id)
        log(`▶ ${labelOf(product)}`)
        const result = await scrape(product)
        if (result.ok || result.retryable === false) {
          await finish(product, labelOf(product), result)
        } else {
          deferred.push({ product, first: result })
          log(`… ${labelOf(product)} failed for now; will try again after a cool-down`)
          if (result.rateLimited) {
            const pause = options.rateLimitPauseMs ?? RATE_LIMIT_PAUSE_MS
            log(`store is rate-limiting; pausing ${pause / 1000}s before the next product`)
            await sleep(pause)
          }
        }
      }
      // Products added while this run was busy (never scraped yet) are picked up now,
      // instead of waiting up to 2 hours for the next scheduled run.
      const { rows: added } = await query(
        'SELECT * FROM tracked_products WHERE is_active AND last_scraped_at IS NULL ORDER BY id',
      )
      queue = added.filter((p) => !done.has(p.id))
      if (queue.length) log(`picking up ${queue.length} product(s) added during this run`)
    }

    // Pass 2: one more try for the held-back products after a cool-down. Still ONE row per product,
    // whose attempts/errors include both passes (so a pass-2 success is honestly labelled "retried").
    if (deferred.length) {
      const delay = options.secondPassDelayMs ?? SECOND_PASS_DELAY_MS
      log(`second pass: ${deferred.length} product(s) in ${delay / 1000}s`)
      await sleep(delay)
      for (const { product, first } of deferred) {
        log(`▶ (second pass) ${labelOf(product)}`)
        const second = await scrape(product, 2)
        const errors = [...first.errors, `second pass after ${delay / 1000}s cool-down`, ...second.errors]
        const merged = {
          ...second,
          attempts: first.attempts + second.attempts,
          errors,
          notes: [...(first.notes ?? []), ...(second.notes ?? [])],
          error: second.ok ? undefined : errors.join(' | '),
        }
        await finish(product, labelOf(product), merged)
      }
    }

    await query(
      `UPDATE scrape_runs SET status = 'completed', finished_at = now(),
              products_total = $2, products_succeeded = $3, products_failed = $4 WHERE id = $1`,
      [run.id, done.size, succeeded, failed],
    )
    log(`run finished: ${succeeded} succeeded, ${failed} failed`)
    return { runId: run.id, succeeded, failed }
  } catch (err) {
    log(`run crashed: ${err.stack ?? err.message}`)
    await query(
      `UPDATE scrape_runs SET status = 'failed', finished_at = now(), error = $2,
              products_succeeded = $3, products_failed = $4 WHERE id = $1`,
      [run.id, err.message, succeeded, failed],
    ).catch((e) => console.error('[runner] could not close run:', e.message))
    throw err
  } finally {
    await browser?.close().catch(() => {})
  }
}

/**
 * Save ONE row for this product in this run. The outcome is derived from what actually happened:
 *   failed  -> no usable data (price/stock NULL)
 *   success -> data on the first try, no retry at any level
 *   retried -> data, but only after our retry or a re-request inside the page
 */
async function recordAttempt(product, run, result) {
  const outcome = !result.ok ? 'failed' : result.attempts === 1 && result.pageRetries === 0 ? 'success' : 'retried'
  // For retried rows, keep what went wrong on the way (honest log); for failed rows, why it failed.
  const problems = [...(result.errors ?? []), ...(result.notes ?? [])]
  const values = [
    product.id,
    run.id,
    outcome,
    result.ok ? result.price : null,
    result.ok ? result.stock : null,
    result.ok ? result.mrp : null,
    result.ok ? result.currency : null,
    result.attempts ?? 1,
    result.ok ? result.pageRetries : 0,
    result.durationMs ?? null,
    problems.length ? problems.join(' | ').slice(0, 2000) : null,
    result.ok ? result.rawPriceText : null,
    result.ok ? result.layoutVariant : null,
    run.trigger,
    result.ok ? JSON.stringify(result.extra ?? {}) : null,
  ]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO scrape_attempts (tracked_product_id, run_id, outcome, price, stock, mrp, currency, attempts,
                                    page_retries, duration_ms, error, raw_price_text, layout_variant, trigger, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      values,
    )
    await client.query('UPDATE tracked_products SET last_scraped_at = now() WHERE id = $1', [product.id])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // The database refused the row (e.g. a guardrail). Never lose the attempt: record it as failed.
    console.error('[runner] could not save attempt, recording as failed:', err.message)
    await query(
      `INSERT INTO scrape_attempts (tracked_product_id, run_id, outcome, attempts, error, trigger)
       VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [product.id, run.id, result.attempts ?? 1, `could not save result: ${err.message}`, run.trigger],
    )
    await query('UPDATE tracked_products SET last_scraped_at = now() WHERE id = $1', [product.id])
  } finally {
    client.release()
  }
}

/** Convenience: open a run and execute it in the background. Returns the run row, or throws RunInProgressError. */
export async function startRunInBackground(trigger, options = {}) {
  const run = await createRun(trigger)
  executeRun(run, options).catch((err) => console.error(`[run ${run.id}] failed:`, err.message))
  return run
}
