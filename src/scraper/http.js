import { config } from '../config.js'

// Every plain-HTTP request to the mock store goes through fetchStoreJson().
// It gives us, in one place:
//   - politeness: a minimum gap between requests across the whole process (the store rate-limits)
//   - timeouts:   a request that hangs is aborted instead of blocking forever
//   - retries:    network errors, timeouts, 429 and 5xx are retried with exponential backoff
//   - validation: the JSON is checked against the shape we expect before anyone uses it

const MIN_GAP_MS = 600 // ~350ms triggered 429s during recon; 600ms was consistently accepted
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class StoreHttpError extends Error {
  constructor(message, { status = null, kind = 'http', retryable = false } = {}) {
    super(message)
    this.name = 'StoreHttpError'
    this.status = status // HTTP status, if there was a response
    this.kind = kind // 'http' | 'timeout' | 'network' | 'shape'
    this.retryable = retryable
  }
}

// ---- politeness: a shared "next free slot" so concurrent callers queue up ----
let nextSlotAt = 0

async function waitForSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + MIN_GAP_MS // reserve synchronously, so two callers never get the same slot
  if (slot > now) await sleep(slot - now)
}

// When the store says "slow down", every caller should back off, not just the one that got the 429.
function coolDown(ms) {
  nextSlotAt = Math.max(nextSlotAt, Date.now() + ms)
}

function backoffDelay(attempt, retryAfterHeader) {
  const retryAfterSec = Number(retryAfterHeader)
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 30_000)
  const exponential = 800 * 2 ** (attempt - 1) // 0.8s, 1.6s, 3.2s, 6.4s ...
  return Math.min(exponential, 10_000) + Math.floor(Math.random() * 300) // + jitter
}

async function fetchOnce(url, timeoutMs) {
  let res
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    throw new StoreHttpError(timedOut ? `timed out after ${timeoutMs}ms` : `network error: ${err.message}`, {
      kind: timedOut ? 'timeout' : 'network',
      retryable: true,
    })
  }

  if (!res.ok) {
    const error = new StoreHttpError(`HTTP ${res.status}`, {
      status: res.status,
      retryable: RETRYABLE_STATUS.has(res.status),
    })
    error.retryAfter = res.headers.get('retry-after')
    throw error
  }

  try {
    return await res.json()
  } catch {
    // e.g. an HTML error page served with status 200
    throw new StoreHttpError('response was not valid JSON', { status: res.status, kind: 'shape', retryable: true })
  }
}

/**
 * GET a JSON endpoint on the store, with politeness, timeout, retries and validation.
 * @param {string} path            e.g. "/api/v2/items/2565"
 * @param {object} options
 * @param {(data:any)=>void} [options.validate]  throw an Error if the data has the wrong shape
 * @param {number} [options.maxAttempts=4]
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{data:any, attempts:number}>}
 */
export async function fetchStoreJson(path, { validate, maxAttempts = 4, timeoutMs = 15_000 } = {}) {
  const url = `${config.storeBaseUrl}${path}`
  let lastError
  let attempt

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForSlot()
    try {
      const data = await fetchOnce(url, timeoutMs)
      if (validate) {
        try {
          validate(data)
        } catch (err) {
          throw new StoreHttpError(`unexpected response shape: ${err.message}`, { kind: 'shape', retryable: true })
        }
      }
      return { data, attempts: attempt }
    } catch (err) {
      lastError = err
      if (!err.retryable || attempt === maxAttempts) break
      const delay = backoffDelay(attempt, err.retryAfter)
      if (err.status === 429 || err.status === 503) coolDown(delay)
      console.warn(`[store] ${path} attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  lastError.attempts = Math.min(attempt, maxAttempts) // how many tries were actually made
  throw lastError
}
