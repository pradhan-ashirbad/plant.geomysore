-- Migration 004: normalized table for Slurry Samples ("Au in Solids"),
-- one row per tank per day (no time-slot — this is a once-daily sample,
-- unlike Leaching's 6x/day readings).
--
-- src/slurryStore.js auto-creates this table on first use too, so running
-- this file by hand is optional — it's here for documentation/consistency
-- with the Leaching migration.

CREATE TABLE IF NOT EXISTS slurry_readings (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  tank TEXT NOT NULL,              -- LT3..LT10, DT1..DT4
  au NUMERIC,
  au_below_detection BOOLEAN DEFAULT false,
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entry_date, tank)
);
CREATE INDEX IF NOT EXISTS idx_slurry_readings_date ON slurry_readings (entry_date);
