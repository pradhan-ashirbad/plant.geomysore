'use strict';
/**
 * One-time data migration: copies existing Crushing rows out of the old
 * generic sheet_rows store into the new typed `crushing` table.
 *
 * Run this AFTER creating the crushing table (db/migrate-002-crushing-table.sql)
 * and BEFORE (or right after) deploying the app code that routes Crushing
 * through the typed table — it reads straight from sheet_rows regardless.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-crushing-data.js
 *
 * Safe to re-run: it always starts by clearing the crushing table, so
 * re-running just re-copies the current sheet_rows data.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { SH } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function coerce(value, sqlType) {
  if (value === '' || value === null || value === undefined) return null;
  if (sqlType === 'numeric') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return value;
}

async function main() {
  const defs = columnDefsFor(SH.CRUSHING);
  const { rows } = await pool.query(
    'SELECT row_data FROM sheet_rows WHERE sheet_name = $1 ORDER BY id ASC',
    [SH.CRUSHING]
  );
  console.log(`Found ${rows.length} existing Crushing rows in sheet_rows.`);

  await pool.query('DELETE FROM crushing');

  let inserted = 0;
  for (const { row_data } of rows) {
    const obj = {};
    defs.forEach((d, i) => { obj[d.column] = coerce(row_data[i], d.sqlType); });
    const columns = Object.keys(obj);
    const values = columns.map(c => obj[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    await pool.query(`INSERT INTO crushing (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
    inserted++;
  }

  console.log(`Migrated ${inserted} rows into the crushing table.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
