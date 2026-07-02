-- Plant Monitoring System — Postgres schema (Supabase)
-- Run this once in Supabase's SQL Editor.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT,
  email TEXT,
  active BOOLEAN DEFAULT true
);

-- Generic sheet-row store: mirrors the old Google Sheets "sheet of rows" model
-- so all existing app logic (column lookup by header name) keeps working.
CREATE TABLE IF NOT EXISTS sheet_headers (
  sheet_name TEXT PRIMARY KEY,
  headers JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_rows (
  id BIGSERIAL PRIMARY KEY,
  sheet_name TEXT NOT NULL,
  row_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet ON sheet_rows (sheet_name, id);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  username TEXT,
  action TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
