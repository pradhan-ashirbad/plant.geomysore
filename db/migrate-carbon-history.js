'use strict';
/**
 * One-time historical backfill for Carbon in Leaching Tank from the plant's
 * Excel log. The workbook has two related sheets, both keyed by date × tank
 * (LT4–LT10), which this importer detects by shape and merges into the same
 * normalized carbon_readings rows via the (date, tank) upsert:
 *
 *   • Weight sheet — a "DATE" header, tank names (LT 4 …) spanning three
 *     sub-columns each: WET / DRY / C tonnage. A trailing "Total C dry
 *     weight" column is ignored (recomputed on the fly by the app).
 *   • Au sheet — a "Tank→" header naming LT 4 … LT 10, a "Date↓" label row,
 *     then one Au(ppm) reading per tank per day (same layout as Slurry).
 *
 * Goes through db.appendRow(SH.CARBON, ...) — the same path a live entry-form
 * submission uses. carbon_readings has a UNIQUE(entry_date, tank) key and the
 * store upserts with COALESCE, so this importer is idempotent (re-running
 * rewrites the same readings) and the two sheets merge cleanly onto the same
 * per-tank rows regardless of import order.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-carbon-history.js <workbook.xlsx> [more...]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH, CARBON_TANKS } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { dateToISO, loadWorkbook } = require('./_leachExcelUtils');

const CARBON_HEADERS = columnDefsFor(SH.CARBON).map(d => d.header);
const CARBON_HEADER_SET = new Set(CARBON_HEADERS);
const CARBON_TANK_SET = new Set(CARBON_TANKS);

function toWideRow(values) {
  return CARBON_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

// "LT 4" / "LT4" -> "LT4" (source headers carry a space, the app's keys don't).
function normalizeTank(label) {
  const m = String(label || '').trim().match(/^LT\s*(\d{1,2})$/i);
  return m ? `LT${m[1]}` : null;
}

function isBlankRow(row) {
  return !row || row.every(c => c === '' || c === null || c === undefined);
}

// ── Au sheet: "Tank→" header naming the tanks, one Au(ppm) per tank per day ─────
function parseAuSheet(rows, skippedCols) {
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (/^tank/i.test(String(rows[i][0] || '').trim())) { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) return null;

  const header = rows[hdrIdx];
  const colTank = header.map((cell, i) => {
    if (i === 0) return null;
    const tank = normalizeTank(cell);
    if (!tank) { if (String(cell || '').trim()) skippedCols.add(String(cell)); return null; }
    if (!CARBON_TANK_SET.has(tank)) { skippedCols.add(String(cell)); return null; }
    return tank;
  });

  const dayRows = [];
  for (let r = hdrIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const iso = dateToISO(row[0]);
    if (!iso) continue; // "Date↓" label row, blanks, trailer notes
    const values = { Date: iso };
    let any = false;
    colTank.forEach((tank, i) => {
      if (!tank) return;
      const v = row[i];
      if (v === '' || v === null || v === undefined) return;
      values[`${tank} Au (ppm)`] = v;
      any = true;
    });
    if (any) dayRows.push(values);
  }
  return dayRows;
}

async function processWorkbook(input, skippedCols) {
  const wb = loadWorkbook(input);
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    if (!rows.length) continue;

    // Au sheet? (a "Tank→" header). Otherwise try the weight sheet (a "DATE"
    // header). A sheet matching neither is skipped silently.
    const isAu = rows.slice(0, 6).some(r => /^tank/i.test(String(r[0] || '').trim()));
    const isWeight = rows.slice(0, 6).some(r => String(r[0] || '').trim().toLowerCase() === 'date');

    if (isAu) {
      const dayRows = parseAuSheet(rows, skippedCols) || [];
      for (const values of dayRows) { await db.appendRow(SH.CARBON, toWideRow(values)); rowsImported++; }
    } else if (isWeight) {
      const dayRows = collectWeightRows(rows, skippedCols);
      for (const values of dayRows) { await db.appendRow(SH.CARBON, toWideRow(values)); rowsImported++; }
    }
  }

  return { rowsImported };
}

// Pulls the weight sheet's per-day value objects out (kept separate from the
// awaiting loop so parsing stays pure/testable).
function collectWeightRows(rows, skippedCols) {
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === 'date') { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) return [];

  const tankRow = rows[hdrIdx];
  const tankCols = [];
  tankRow.forEach((cell, col) => {
    const tank = normalizeTank(cell);
    if (!tank) return;
    if (!CARBON_TANK_SET.has(tank)) { skippedCols.add(String(cell)); return; }
    tankCols.push({ tank, wetCol: col, dryCol: col + 1, tonCol: col + 2 });
  });
  if (!tankCols.length) return [];

  const out = [];
  for (let r = hdrIdx + 2; r < rows.length; r++) {
    const row = rows[r];
    if (isBlankRow(row)) continue;
    const iso = dateToISO(row[0]);
    if (!iso) continue;
    const values = { Date: iso };
    let any = false;
    tankCols.forEach(({ tank, wetCol, dryCol, tonCol }) => {
      const wet = row[wetCol], dry = row[dryCol], ton = row[tonCol];
      if (wet !== '' && wet !== null && wet !== undefined) { values[`${tank} Wet`] = wet; any = true; }
      if (dry !== '' && dry !== null && dry !== undefined) { values[`${tank} Dry`] = dry; any = true; }
      if (ton !== '' && ton !== null && ton !== undefined) { values[`${tank} C Tonnage`] = ton; any = true; }
    });
    if (any) out.push(values);
  }
  return out;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-carbon-history.js <workbook.xlsx> [more...]');
    process.exit(1);
  }

  const skippedCols = new Set();
  let totalRows = 0;
  for (const f of files) {
    console.log(`Processing ${f} ...`);
    const { rowsImported } = await processWorkbook(f, skippedCols);
    console.log(`  ${rowsImported} tank-day write(s) imported.`);
    totalRows += rowsImported;
  }

  if (skippedCols.size) {
    console.log('\nColumns seen but not recognized as a tank:');
    console.log('  ' + Array.from(skippedCols).sort().join(', '));
  }

  console.log(`\nDone. ${totalRows} tank-day write(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook, parseAuSheet, collectWeightRows };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
