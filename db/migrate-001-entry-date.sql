-- Migration 001: add indexed entry_date to sheet_rows for fast date filtering.
-- Run this once in Supabase's SQL Editor.

ALTER TABLE sheet_rows ADD COLUMN IF NOT EXISTS entry_date DATE;

-- Backfill from existing rows. The Date value is the first element of the
-- row_data JSON array for all data sheets. Handles ISO strings ("2026-07-01"),
-- DD/MM/YYYY strings, and Excel serial numbers (e.g. 45840).
UPDATE sheet_rows SET entry_date =
  CASE
    WHEN (row_data->>0) ~ '^\d{4}-\d{2}-\d{2}'
      THEN substring(row_data->>0 from '^\d{4}-\d{2}-\d{2}')::date
    WHEN (row_data->>0) ~ '^\d{1,2}/\d{1,2}/\d{4}'
      THEN to_date(row_data->>0, 'DD/MM/YYYY')
    WHEN (row_data->>0) ~ '^\d{5}(\.\d+)?$'
      THEN DATE '1899-12-30' + floor((row_data->>0)::numeric)::int
    ELSE NULL
  END
WHERE entry_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_date
  ON sheet_rows (sheet_name, entry_date);
