// Creates (or updates) the database tables by running src/db/schema.sql.
// Usage: npm run db:migrate
import { readFile } from 'node:fs/promises'
import { pool } from '../src/db/pool.js'

const sql = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8')

try {
  await pool.query(sql)
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  )
  console.log('Schema applied. Tables:', rows.map((r) => r.table_name).join(', '))
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
