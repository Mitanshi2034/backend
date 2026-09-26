import 'dotenv/config'

// Every setting the backend reads from the environment lives here, so there is one place to look.
// Locally these come from backend/.env; on Render they are set in the service's Environment tab.

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT) || 4000,

  // Supabase Postgres connection string (use the Session Pooler URL, see HOW_TO.md).
  databaseUrl: required('DATABASE_URL'),
  // Supabase requires SSL. Set DATABASE_SSL=false only for a local Postgres.
  databaseSsl: process.env.DATABASE_SSL !== 'false',

  // Comma-separated list of frontend origins allowed to call this API.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Shared secret cron-job.org must send to trigger a scheduled scrape.
  cronSecret: process.env.CRON_SECRET || '',

  storeBaseUrl: (process.env.STORE_BASE_URL || 'https://demo.inelabteamdev.com').replace(/\/$/, ''),

  // false = open a visible browser window (headed mode, for watching the scraper).
  headless: process.env.HEADLESS !== 'false',
}
