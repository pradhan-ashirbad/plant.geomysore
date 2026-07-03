'use strict';
/**
 * One-time historical backfill for Detox (DT1-DT4) tank readings from the
 * plant's day-per-sheet "Detox Log Sheet" Excel workbook.
 *
 * Unlike the Leaching workbook, this one has a fully consistent header
 * across every day-sheet ("Detox T1 Feed CN (ppm)", "Detox T4 Outlet
 * CN (ppm)", ...) — only DT1 (Feed) and DT4 (Outlet) have historical data;
 * DT2/DT3 aren't in the source file at all and will only get readings from
 * live entries going forward.
 *
 * Run this AFTER creating leaching_readings/detox_readings
 * (db/migrate-003-leaching-tables.sql) and deploying src/leachingStore.js.
 * Goes through db.appendRow(SH.LEACHING, ...) — the exact same code path a
 * live entry-form submission uses. Safe to re-run: each (date, time_slot,
 * tank) is upserted, so re-running just rewrites the same values.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-detox-history.js <workbook.xlsx> [more workbooks...]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { canonParam, parseTankColumn, timeToHHMM, dateToISO, findHeaderRowIndex } = require('./_leachExcelUtils');

const LEACH_HEADERS = columnDefsFor(SH.LEACHING).map(d => d.header);
const LEACH_HEADER_SET = new Set(LEACH_HEADERS);

// Sheets that are reference/lookup tables, not day logs.
const NON_DAY_SHEETS = new Set(['Dosing Table', 'Settings', 'Sheet1', 'Sheet2', 'Sheet5']);

function toWideRow(values) {
  return LEACH_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

async function processWorkbook(filePath, skippedCols) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  let sheetsProcessed = 0;
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    if (NON_DAY_SHEETS.has(sheetName) || !/^\d{1,2}\.\d{1,2}$/.test(sheetName.trim())) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const headerIdx = findHeaderRowIndex(rows);
    if (headerIdx === -1) {
      console.warn(`  [${sheetName}] no header row found — skipped`);
      continue;
    }
    sheetsProcessed++;

    const header = rows[headerIdx];
    const colMap = header.map((h) => {
      const label = String(h || '').trim();
      if (!label) return null;
      if (/^date$/i.test(label)) return { special: 'date' };
      if (/^time$/i.test(label)) return { special: 'time' };
      const parsed = parseTankColumn(label);
      if (!parsed) { skippedCols.add(label); return null; }
      const canon = canonParam(parsed.paramRaw);
      if (!canon) { skippedCols.add(label); return null; }
      return { tank: parsed.tank, param: canon };
    });

    const dateColIdx = colMap.findIndex(c => c && c.special === 'date');
    const timeColIdx = colMap.findIndex(c => c && c.special === 'time');

    let currentDate = null;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];

      if (dateColIdx >= 0 && row[dateColIdx] !== '' && row[dateColIdx] != null) {
        const iso = dateToISO(row[dateColIdx]);
        if (iso) currentDate = iso;
      }
      const hhmm = timeColIdx >= 0 ? timeToHHMM(row[timeColIdx]) : null;
      if (!hhmm || !currentDate) continue;

      const values = { Date: currentDate, Time: hhmm };
      let any = false;
      colMap.forEach((c, i) => {
        if (!c || !c.tank) return;
        const raw = row[i];
        if (raw === '' || raw === null || raw === undefined) return;
        const key = `${c.tank} ${c.param}`;
        if (LEACH_HEADER_SET.has(key)) { values[key] = raw; any = true; }
        else skippedCols.add(key);
      });
      if (!any) continue;

      await db.appendRow(SH.LEACHING, toWideRow(values));
      rowsImported++;
    }
  }

  return { sheetsProcessed, rowsImported };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-detox-history.js <workbook.xlsx> [more...]');
    process.exit(1);
  }

  const skippedCols = new Set();
  let totalSheets = 0, totalRows = 0;
  for (const f of files) {
    console.log(`Processing ${f} ...`);
    const { sheetsProcessed, rowsImported } = await processWorkbook(f, skippedCols);
    console.log(`  ${sheetsProcessed} day-sheet(s), ${rowsImported} reading row(s) imported.`);
    totalSheets += sheetsProcessed;
    totalRows += rowsImported;
  }

  if (skippedCols.size) {
    console.log('\nColumns seen in the file(s) but NOT imported (unrecognized columns):');
    console.log('  ' + Array.from(skippedCols).sort().join(', '));
  }

  console.log(`\nDone. ${totalSheets} day-sheet(s), ${totalRows} reading row(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
