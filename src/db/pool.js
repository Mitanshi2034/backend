import pg from 'pg'
import { config } from '../config.js'

// One shared connection pool for the whole app.
// max is kept small because Supabase's free tier limits the number of connections.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (err) => {
  // An idle client lost its connection (e.g. Supabase restarted). The pool replaces it on the next query.
  console.error('[db] idle client error:', err.message)
})

export const query = (text, params) => pool.query(text, params)
