'use strict';
/**
 * One-time backfill: recomputes TPH = Production / Running Hours for every
 * existing row in the typed `crushing` table where tph is missing, wrong,
 * or the row predates the auto-calc fix.
 *
 * Usage:
 *   DATABASE_URL=... node db/backfill-crushing-tph.js
 *
 * Safe to re-run — it always recalculates from running_hours/production,
 * so running it twice just re-confirms the same numbers.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows } = await pool.query('SELECT id, running_hours, production, tph FROM crushing');
  console.log(`Found ${rows.length} rows in crushing.`);

  let updated = 0;
  for (const row of rows) {
    const hrs = parseFloat(row.running_hours);
    const prod = parseFloat(row.production);
    if (isNaN(hrs) || isNaN(prod) || hrs <= 0) continue;

    const correctTph = +(prod / hrs).toFixed(2);
    const currentTph = row.tph === null ? null : parseFloat(row.tph);
    if (currentTph === correctTph) continue;

    await pool.query('UPDATE crushing SET tph = $1 WHERE id = $2', [correctTph, row.id]);
    console.log(`  row ${row.id}: tph ${row.tph} -> ${correctTph}`);
    updated++;
  }

  console.log(`Backfill complete. ${updated} row(s) corrected.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
