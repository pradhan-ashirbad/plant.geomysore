-- Migration 005: give Filter Press a real typed table instead of storing its
-- rows inside the generic sheet_rows JSON store.
-- No Filter Press data was ever entered under the old generic-store schema
-- (it was a placeholder that didn't match the plant's real log), so there is
-- no data-migration script to run afterward — just deploy the app code
-- (already routed in src/typedTables.js's TYPED_TABLES map) and then, if
-- desired, run db/migrate-filterpress-history.js to backfill historical
-- months from the plant's Excel logs.

-- entry_date is UNIQUE: Filter Press is a one-row-per-day log, so a re-import
-- or a same-day correction upserts (overwrites) the existing row instead of
-- appending a duplicate (see UPSERT_KEY in src/typedTables.js).
CREATE TABLE IF NOT EXISTS filter_press (
  id SERIAL PRIMARY KEY,
  entry_date DATE UNIQUE,
  cycles NUMERIC,
  cake_wt NUMERIC,
  moisture NUMERIC,
  dry_wt NUMERIC,
  au NUMERIC,
  au_g NUMERIC,
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filter_press_entry_date ON filter_press (entry_date);
