-- Migration 003: give Leaching (LT4-LT10) and Detox (DT1-DT4) tanks real,
-- normalized tables instead of storing each reading as ~40 columns in one
-- giant sheet_rows JSON blob.
--
-- Unlike Crushing's typed table (a 1:1 column mirror of the old wide row),
-- these are "long format": one row per tank per reading time, not one row
-- per timestamp. This scales cleanly as tanks are added/removed and makes
-- per-tank queries (trend, limit breaches) a simple indexed filter instead
-- of picking specific columns out of a wide row.
--
-- src/leachingStore.js pivots these back into the same wide-row shape the
-- rest of the app already expects (see columnDefsFor(SH.LEACHING) in
-- src/sheetUtils.js), so no other app code needs to know this table split
-- exists.
--
-- Run this once in Supabase's SQL Editor, in order:
--   1. Create the tables (this file)
--   2. Deploy the app code (src/leachingStore.js + src/db.js routing)
--   3. Run db/migrate-leaching-history.js and db/migrate-detox-history.js
--      locally to backfill historical readings from the Excel logs

CREATE TABLE IF NOT EXISTS leaching_readings (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  time_slot TEXT NOT NULL,             -- one of '03:00','07:00','11:00','15:00','19:00','23:00'
  tank TEXT NOT NULL,                  -- LT4..LT10
  nacn NUMERIC,
  nacn_below_detection BOOLEAN DEFAULT false,
  ph NUMERIC,
  dissolved_oxygen NUMERIC,
  au NUMERIC,
  au_below_detection BOOLEAN DEFAULT false,
  overflow TEXT,                       -- 'Yes' / 'No' / null
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entry_date, time_slot, tank)
);
CREATE INDEX IF NOT EXISTS idx_leaching_readings_date ON leaching_readings (entry_date);

CREATE TABLE IF NOT EXISTS detox_readings (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  time_slot TEXT NOT NULL,
  tank TEXT NOT NULL,                  -- DT1..DT4
  role TEXT,                           -- 'feed' / 'outlet' / null (unknown for DT2/DT3 so far)
  nacn NUMERIC,
  nacn_below_detection BOOLEAN DEFAULT false,
  ph NUMERIC,
  au NUMERIC,
  au_below_detection BOOLEAN DEFAULT false,
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entry_date, time_slot, tank)
);
CREATE INDEX IF NOT EXISTS idx_detox_readings_date ON detox_readings (entry_date);
