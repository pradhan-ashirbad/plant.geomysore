-- Migration 006: normalized store for Carbon in Leaching Tank (LT4–LT10).
-- One row per tank per day: a carbon-weight set (Wet, Dry, C Tonnage =
-- Dry × 0.38) plus an Au-on-carbon assay (ppm). The daily "Total C Dry
-- Weight (Ton)" is NOT stored — it's computed on the fly (sum of the 7 tanks).
--
-- src/carbonStore.js AUTO-CREATES this table on first use, so running this by
-- hand is optional — it's here for parity with the other stores and as an
-- explicit record for the production database. UNIQUE(entry_date, tank) drives
-- the COALESCE upsert, so imports/corrections overwrite instead of duplicating.

CREATE TABLE IF NOT EXISTS carbon_readings (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  tank TEXT NOT NULL,
  wet NUMERIC,
  dry NUMERIC,
  c_tonnage NUMERIC,
  au NUMERIC,
  au_below_detection BOOLEAN DEFAULT false,
  notes TEXT,
  submitted_by TEXT,
  entry_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entry_date, tank)
);
CREATE INDEX IF NOT EXISTS idx_carbon_readings_date ON carbon_readings (entry_date);
