-- INE Price Tracker: database schema (Supabase / PostgreSQL)
-- Safe to run more than once: every statement uses IF NOT EXISTS.
-- Run it with `npm run db:migrate` (backend folder) or paste it into Supabase > SQL Editor.

-- ---------------------------------------------------------------------------
-- 1. catalog_products
-- A local copy of the store's catalog, used for search. The store has no
-- search endpoint and reshuffles its listing on every request, so we collect
-- all products once and search our own copy (see docs/STORE_RECON.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_products (
  store_product_id INTEGER PRIMARY KEY,          -- the number in /item/:id
  slug             TEXT,
  name             TEXT NOT NULL,
  brand            TEXT,
  category         TEXT,
  sku              TEXT,
  description      TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_products_name_idx ON catalog_products (lower(name));

-- ---------------------------------------------------------------------------
-- 2. tracked_products
-- One row per (product, option) the user chose to track.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracked_products (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_product_id        INTEGER NOT NULL,
  name                    TEXT NOT NULL,
  brand                   TEXT,
  category                TEXT,
  sku                     TEXT,
  option_axis             TEXT,                   -- e.g. "Kit", "Storage"
  option_id               TEXT NOT NULL,          -- store's option id, e.g. "o2"
  option_label            TEXT NOT NULL,          -- e.g. "Standard kit"
  product_url             TEXT NOT NULL,
  scrape_interval_minutes INTEGER NOT NULL DEFAULT 120
                          CHECK (scrape_interval_minutes BETWEEN 60 AND 1440),
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  last_scraped_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_product_id, option_id)
);

-- ---------------------------------------------------------------------------
-- 3. scrape_runs
-- One row per trigger (cron call, manual button, headed CLI run).
-- Used to stop two runs from overlapping and to show when the scheduler last fired.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_runs (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger             TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'cli')),
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  products_total      INTEGER NOT NULL DEFAULT 0,
  products_succeeded  INTEGER NOT NULL DEFAULT 0,
  products_failed     INTEGER NOT NULL DEFAULT 0,
  error               TEXT
);

-- At most one run can be 'running' at a time. A second trigger that arrives
-- while a run is in progress fails to insert, and is skipped instead of overlapping.
CREATE UNIQUE INDEX IF NOT EXISTS scrape_runs_one_running_idx
  ON scrape_runs ((TRUE)) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- 4. scrape_attempts
-- One row per product per scrape: the scrape log AND the price history.
-- Price history = the rows with outcome success/retried. Because both views
-- come from the same table, they can never disagree.
--
-- outcome meanings:
--   success -> correct price/stock on the first try
--   retried -> correct price/stock, but only after one or more retries
--   failed  -> every retry failed; price and stock are left NULL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_attempts (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracked_product_id BIGINT NOT NULL REFERENCES tracked_products (id) ON DELETE CASCADE,
  run_id             BIGINT REFERENCES scrape_runs (id) ON DELETE SET NULL,
  attempted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome            TEXT NOT NULL CHECK (outcome IN ('success', 'retried', 'failed')),
  price              NUMERIC(12, 2),
  stock              INTEGER,
  mrp                NUMERIC(12, 2),
  currency           TEXT,
  attempts           SMALLINT NOT NULL DEFAULT 1 CHECK (attempts >= 1),  -- scraper-level tries (fresh browser page each)
  page_retries       SMALLINT NOT NULL DEFAULT 0,  -- price re-requested inside the page (store retry / "Check again")
  duration_ms        INTEGER,
  error              TEXT,              -- why it failed, or what went wrong before a retry succeeded
  raw_price_text     TEXT,              -- the exact text we parsed, kept as evidence
  layout_variant     INTEGER,           -- store's manifest variant at scrape time
  trigger            TEXT,
  extra              JSONB,             -- bonus details shown on the dashboard (member price, rating, seller, delivery...)

  -- Guardrail 1: a failed attempt stores NO data; a successful one MUST have
  -- a positive price and a non-negative stock. Wrong/empty data cannot be saved.
  CONSTRAINT scrape_attempts_data_matches_outcome CHECK (
    (outcome = 'failed' AND price IS NULL AND stock IS NULL)
    OR
    (outcome IN ('success', 'retried') AND price IS NOT NULL AND price > 0
      AND stock IS NOT NULL AND stock >= 0)
  ),

  -- Guardrail 2: labels are honest. "success" = worked first time with no retry at any level;
  -- "retried" = worked, but only after our retry or a price re-request inside the page.
  CONSTRAINT scrape_attempts_outcome_matches_attempts CHECK (
    (outcome = 'success' AND attempts = 1 AND page_retries = 0)
    OR (outcome = 'retried' AND (attempts > 1 OR page_retries > 0))
    OR outcome = 'failed'
  )
);

-- Upgrades for databases created before these columns existed (safe to re-run).
ALTER TABLE scrape_attempts ADD COLUMN IF NOT EXISTS page_retries SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE scrape_attempts ADD COLUMN IF NOT EXISTS extra JSONB;
ALTER TABLE scrape_attempts DROP CONSTRAINT IF EXISTS scrape_attempts_outcome_matches_attempts;
ALTER TABLE scrape_attempts ADD CONSTRAINT scrape_attempts_outcome_matches_attempts CHECK (
  (outcome = 'success' AND attempts = 1 AND page_retries = 0)
  OR (outcome = 'retried' AND (attempts > 1 OR page_retries > 0))
  OR outcome = 'failed'
);

CREATE INDEX IF NOT EXISTS scrape_attempts_product_time_idx
  ON scrape_attempts (tracked_product_id, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Lock down Supabase's auto-generated REST API
-- Supabase exposes every table in the public schema over its REST API.
-- Enabling Row Level Security with NO policies blocks that path completely.
-- Our backend connects directly as the table owner, which bypasses RLS,
-- so the app keeps working and the only way in is through our Express API.
-- ---------------------------------------------------------------------------
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_attempts  ENABLE ROW LEVEL SECURITY;
