-- Migration 002: give Crushing a real typed table instead of storing its
-- rows inside the generic sheet_rows JSON store.
-- Run this once in Supabase's SQL Editor, in order:
--   1. Create the table (this file)
--   2. Deploy the app code that routes 'Crushing' through it (already done
--      in src/typedTables.js's TYPED_TABLES map)
--   3. Run db/migrate-crushing-data.js locally to copy any existing rows over

CREATE TABLE IF NOT EXISTS crushing (
  id SERIAL PRIMARY KEY,
  entry_date DATE,
  running_hours NUMERIC,
  production NUMERIC,
  feed_size NUMERIC,
  product_size NUMERIC,
  tph NUMERIC,
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crushing_entry_date ON crushing (entry_date);
