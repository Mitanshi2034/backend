import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

// Protects endpoints that start work on the server (scheduled scrapes, catalog sync).
// The caller must send the secret in the "x-cron-secret" header.
// cron-job.org lets you add custom headers to each job.
export function requireSecret(req, res, next) {
  if (!config.cronSecret) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on the server' })
  }
  const given = Buffer.from(String(req.get('x-cron-secret') ?? ''))
  const expected = Buffer.from(config.cronSecret)
  // timingSafeEqual avoids leaking how many characters matched through response timing
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Invalid or missing x-cron-secret header' })
  }
  next()
}
