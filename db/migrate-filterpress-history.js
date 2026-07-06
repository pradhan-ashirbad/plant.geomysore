'use strict';
/**
 * One-time historical backfill for Filter Press from the plant's Excel log.
 * Single flat sheet: a header row (Date, No of Trips, No.Of Cycles, Cake Wt,
 * Moisture %, Dry Wt, Au (ppm), Au (g)), then one row per date. "No of
 * Trips" is dropped (always blank in every month seen so far, not part of
 * the app's schema). A units-annotation row right after the header (e.g.
 * "MT (cal)" / "MT" under Cake Wt / Dry Wt, no date in its first cell) is
 * skipped automatically since it has no parseable date.
 *
 * Dry Wt and Au (g) are imported as-is from the sheet (not re-derived) so
 * historical figures match the plant's own records exactly, even though the
 * live app now auto-calculates both going forward.
 *
 * Goes through db.appendRow(SH.FILTER, ...) — the same path a live
 * entry-form submission uses. filter_press has a UNIQUE(entry_date) key and
 * appendRow upserts on it, so this importer is idempotent: re-running it on
 * the same file rewrites the same rows instead of duplicating them.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-filterpress-history.js <workbook.xlsx> [more workbooks...]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { dateToISO, findHeaderRowIndex, loadWorkbook } = require('./_leachExcelUtils');

const FILTER_HEADERS = columnDefsFor(SH.FILTER).map(d => d.header);

function toWideRow(values) {
  return FILTER_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

// Matches the sheet's own header text to the app's param keys. "No of
// Trips" (and anything else unrecognized) maps to null and is skipped.
function canonHeader(h) {
  const s = String(h || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^date/.test(s)) return 'Date';
  if (/trip/.test(s)) return null;
  if (/cycle/.test(s)) return 'Cycles';
  if (/cake\s*wt/.test(s)) return 'Cake Wt';
  if (/moisture/.test(s)) return 'Moisture';
  if (/dry\s*wt/.test(s)) return 'Dry Wt';
  if (/au.*\(g\)/.test(s)) return 'Au (g)';
  if (/^au\b/.test(s)) return 'Au';
  return null;
}

async function processWorkbook(input, skippedCols) {
  const wb = loadWorkbook(input);
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    const headerIdx = findHeaderRowIndex(rows);
    if (headerIdx === -1) continue; // not a Filter Press sheet (e.g. an empty Sheet1) — skip silently

    const header = rows[headerIdx];
    const dateColIdx = header.findIndex(h => String(h || '').trim().toLowerCase() === 'date');
    if (dateColIdx === -1) continue;

    const colMap = header.map((h, i) => {
      if (i === dateColIdx) return null; // date handled separately
      const key = canonHeader(h);
      if (!key) { if (String(h || '').trim()) skippedCols.add(String(h).trim()); return null; }
      return key;
    });

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const iso = dateToISO(row[dateColIdx]);
      if (!iso) continue; // the units-annotation row, blank rows, trailer notes

      const values = { Date: iso };
      let any = false;
      colMap.forEach((key, i) => {
        if (!key) return;
        const raw = row[i];
        if (raw === '' || raw === null || raw === undefined) return;
        values[key] = raw;
        any = true;
      });
      if (!any) continue;

      await db.appendRow(SH.FILTER, toWideRow(values));
      rowsImported++;
    }
  }

  return { rowsImported };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-filterpress-history.js <workbook.xlsx> [more...]');
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
    console.log('\nColumns seen but not recognized:');
    console.log('  ' + Array.from(skippedCols).sort().join(', '));
  }

  console.log(`\nDone. ${totalRows} day row(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
