'use strict';
/**
 * One-time historical backfill for Slurry Samples ("Au in Solids") from the
 * plant's Excel log. Unlike Leaching/Detox, this is a single flat sheet:
 * a "Tank→" header row naming the 12 tanks (LT3-LT10, DT1-DT4, written
 * with a space like "LT 3"), then one row per date with an Au (ppm) value
 * per tank (some cells blank, below-detection values as "<0.01").
 *
 * Run this AFTER creating slurry_readings (it also auto-creates on first
 * use) and deploying src/slurryStore.js. Goes through db.appendRow(SH.SLURRY,
 * ...) — the exact same code path a live entry-form submission uses — so
 * historical and live data are normalized identically. Safe to re-run:
 * each (date, tank) is upserted, so re-running just rewrites the same values.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-slurry-history.js <workbook.xlsx> [more workbooks...]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH, SLURRY_AU_TANKS } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { dateToISO, findHeaderRowIndex, loadWorkbook } = require('./_leachExcelUtils');

const SLURRY_HEADERS = columnDefsFor(SH.SLURRY).map(d => d.header);
const SLURRY_HEADER_SET = new Set(SLURRY_HEADERS);
const SLURRY_TANK_SET = new Set(SLURRY_AU_TANKS);

function toWideRow(values) {
  return SLURRY_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

// "LT 3" / "LT3" / "DT 4" -> "LT3" / "DT4" (source header has a space, the
// app's own headers and everywhere else in this codebase don't).
function normalizeTank(label) {
  const m = String(label || '').trim().match(/^(LT|DT)\s*(\d{1,2})$/i);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

async function processWorkbook(input, skippedCols) {
  const wb = loadWorkbook(input);
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });

    // The tank header row says "Tank→" in its first cell, not "Date" — so
    // the shared findHeaderRowIndex (which looks for a literal "Date" cell)
    // won't find it here. Look for "Tank" instead, then treat the first
    // column as the date column regardless of its own label ("Date↓").
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      if (rows[i].some(c => /^tank/i.test(String(c || '').trim()))) { headerIdx = i; break; }
    }
    if (headerIdx === -1) continue; // not a Slurry sheet — skip silently

    const header = rows[headerIdx];
    const colMap = header.map((h, i) => {
      if (i === 0) return { special: 'date' };
      const tank = normalizeTank(h);
      if (!tank) return null;
      if (!SLURRY_TANK_SET.has(tank)) { skippedCols.add(String(h)); return null; }
      return { tank };
    });

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const iso = dateToISO(row[0]);
      if (!iso) continue; // the "Date↓" label row, blank rows, trailer notes

      const values = { Date: iso };
      let any = false;
      colMap.forEach((c, i) => {
        if (!c || !c.tank) return;
        const raw = row[i];
        if (raw === '' || raw === null || raw === undefined) return;
        const key = `${c.tank} Au (ppm)`;
        if (SLURRY_HEADER_SET.has(key)) { values[key] = raw; any = true; }
      });
      if (!any) continue;

      await db.appendRow(SH.SLURRY, toWideRow(values));
      rowsImported++;
    }
  }

  return { rowsImported };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-slurry-history.js <workbook.xlsx> [more...]');
    process.exit(1);
  }

  const skippedCols = new Set();
  let totalRows = 0;
  for (const f of files) {
    console.log(`Processing ${f} ...`);
    const { rowsImported } = await processWorkbook(f, skippedCols);
    console.log(`  ${rowsImported} day row(s) imported.`);
    totalRows += rowsImported;
  }

  if (skippedCols.size) {
    console.log('\nColumns seen but not recognized as a tank:');
    console.log('  ' + Array.from(skippedCols).sort().join(', '));
  }

  console.log(`\nDone. ${totalRows} day row(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
