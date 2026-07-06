'use strict';
/**
 * One-time historical backfill for Leaching (LT4-LT10) tank readings from
 * the plant's day-per-sheet Excel logs.
 *
 * The source workbooks are inconsistent sheet to sheet — different tank
 * sets present (some months skip LT9, some skip LT10), Au sometimes
 * missing entirely, and a couple of months use an extra Shift/Operator
 * column layout that never fills in the Date cell at all (only the sheet
 * tab name, e.g. "04.09", carries day/month — no year anywhere in the
 * sheet). This script reads each day-sheet's own header row and only
 * writes the tank/param columns that sheet actually has; for sheets with
 * no in-cell date it infers the year from sibling sheets in the same
 * workbook that DO have one for the same month, falling back to an
 * explicit --year=YYYY flag if that's not possible either.
 *
 * Run this AFTER creating leaching_readings/detox_readings
 * (db/migrate-003-leaching-tables.sql) and deploying src/leachingStore.js.
 * Goes through db.appendRow(SH.LEACHING, ...) — the exact same code path a
 * live entry-form submission uses — so historical and live data are
 * normalized identically. Safe to re-run: each (date, time_slot, tank) is
 * upserted, so re-running just rewrites the same values.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-leaching-history.js <workbook.xlsx> [more workbooks...] [--year=YYYY]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { canonParam, parseTankColumn, timeToHHMM, dateToISO, findHeaderRowIndex, loadWorkbook } = require('./_leachExcelUtils');

const LEACH_HEADERS = columnDefsFor(SH.LEACHING).map(d => d.header);
const LEACH_HEADER_SET = new Set(LEACH_HEADERS);

function toWideRow(values) {
  return LEACH_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

function buildColMap(header, skippedCols) {
  return header.map((h) => {
    const label = String(h || '').trim();
    if (!label) return null;
    if (/^date$/i.test(label)) return { special: 'date' };
    if (/^time$/i.test(label)) return { special: 'time' };
    if (/^operator$/i.test(label)) return { special: 'operator' };
    if (/^shift$/i.test(label)) return null; // redundant with the Time-derived slot
    const parsed = parseTankColumn(label);
    if (!parsed) { skippedCols.add(label); return null; }
    const canon = canonParam(parsed.paramRaw);
    if (!canon) { skippedCols.add(label); return null; }
    return { tank: parsed.tank, param: canon };
  });
}

/**
 * 22 April day-sheets carry a SECOND mini-table further down the sheet
 * ("D O (ppm) of leaching Tanks") with its own header row, its own Time
 * column at a different position, and tank columns labeled just "LT 4",
 * "LT 5", etc (DO is implied by the block title, not per-column). It has
 * no Date column of its own — it belongs to the same single day as the
 * main table above it. Returns the row index of the DO block's own header
 * row (the row right after the title), or -1 if this sheet has no such
 * block.
 */
function findDoBlockHeaderIndex(rows) {
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].some(c => /D\s*O\s*\(ppm\)/i.test(String(c)))) return i + 1;
  }
  return -1;
}

async function processDoBlock(rows, doHeaderIdx, sheetDate, skippedCols) {
  if (!sheetDate) return 0;
  const header = rows[doHeaderIdx];
  const colMap = header.map((h) => {
    const label = String(h || '').trim();
    if (!label) return null;
    if (/^time$/i.test(label)) return { special: 'time' };
    const m = label.match(/^LT\s*(\d{1,2})$/i);
    if (m) return { tank: `LT${m[1]}`, param: 'DO (ppm)' };
    skippedCols.add(`[DO block] ${label}`);
    return null;
  });
  const timeColIdx = colMap.findIndex(c => c && c.special === 'time');
  if (timeColIdx === -1) return 0;

  let imported = 0;
  for (let r = doHeaderIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const hhmm = timeToHHMM(row[timeColIdx]);
    if (!hhmm) continue;

    const values = { Date: sheetDate, Time: hhmm };
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
    imported++;
  }
  return imported;
}

/**
 * Some day-sheets (a Sept layout with Shift/Operator columns) never put a
 * date in any cell — only the sheet's own tab name ("04.09") encodes
 * day/month, with no year. Build a month -> year map from whichever sheets
 * in this same workbook DO have an explicit dated cell, so those undated
 * sheets can still be placed on the calendar correctly.
 */
function inferMonthYearMap(wb) {
  const monthToYear = {};
  for (const sheetName of wb.SheetNames) {
    if (!/^\d{1,2}\.\d{1,2}$/.test(sheetName.trim())) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    const headerIdx = findHeaderRowIndex(rows);
    if (headerIdx === -1) continue;
    const dateColIdx = rows[headerIdx].findIndex(h => /^date$/i.test(String(h || '').trim()));
    if (dateColIdx === -1) continue;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const iso = dateToISO(rows[r][dateColIdx]);
      if (iso) monthToYear[iso.slice(5, 7)] = iso.slice(0, 4);
    }
  }
  return monthToYear;
}

async function processWorkbook(input, skippedCols, opts = {}) {
  const wb = loadWorkbook(input);
  const monthToYear = inferMonthYearMap(wb);
  const undatedSheets = [];
  let sheetsProcessed = 0;
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    const trimmed = sheetName.trim();
    const nameMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!nameMatch) continue; // skip Settings/Sheet1/etc.
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const headerIdx = findHeaderRowIndex(rows);
    if (headerIdx === -1) {
      console.warn(`  [${sheetName}] no header row found — skipped`);
      continue;
    }
    sheetsProcessed++;

    const header = rows[headerIdx];
    const colMap = buildColMap(header, skippedCols);
    const dateColIdx = colMap.findIndex(c => c && c.special === 'date');
    const timeColIdx = colMap.findIndex(c => c && c.special === 'time');

    // Fallback date if this sheet's Date column is never actually filled in:
    // day/month from the tab name, year from sibling sheets, or --year.
    const [, day, month] = nameMatch;
    const fallbackYear = monthToYear[month.padStart(2, '0')] || opts.defaultYear;
    const fallbackDate = fallbackYear ? `${fallbackYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : null;
    let usedFallback = false;

    let currentDate = null;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];

      if (dateColIdx >= 0 && row[dateColIdx] !== '' && row[dateColIdx] != null) {
        const iso = dateToISO(row[dateColIdx]);
        if (iso) currentDate = iso;
      }
      const hhmm = timeColIdx >= 0 ? timeToHHMM(row[timeColIdx]) : null;
      if (!hhmm) continue; // notes/instructions/blank row, not a reading

      let rowDate = currentDate;
      if (!rowDate && fallbackDate) { rowDate = fallbackDate; usedFallback = true; }
      if (!rowDate) continue; // no date available anywhere for this row — can't place it, skip

      const values = { Date: rowDate, Time: hhmm };
      let operator = null;
      let any = false;
      colMap.forEach((c, i) => {
        if (!c) return;
        const raw = row[i];
        if (raw === '' || raw === null || raw === undefined) return;
        if (c.special === 'operator') { operator = String(raw).trim(); return; }
        if (c.tank) {
          const key = `${c.tank} ${c.param}`;
          if (LEACH_HEADER_SET.has(key)) { values[key] = raw; any = true; }
          else skippedCols.add(key); // e.g. LT1-LT3 columns present in some sheets but always empty
        }
      });
      if (!any) continue;
      if (operator) values['Submitted By'] = operator;

      await db.appendRow(SH.LEACHING, toWideRow(values));
      rowsImported++;
    }

    // Some sheets carry a second "DO (ppm)" mini-table further down with
    // its own header/Time column — it belongs to this same sheet's date.
    const doHeaderIdx = findDoBlockHeaderIndex(rows);
    if (doHeaderIdx !== -1) {
      const sheetDate = currentDate || (usedFallback ? fallbackDate : null);
      rowsImported += await processDoBlock(rows, doHeaderIdx, sheetDate, skippedCols);
    }

    if (usedFallback) undatedSheets.push(`${sheetName} -> ${fallbackDate} (year ${fallbackDate === null ? '?' : monthToYear[month.padStart(2,'0')] ? 'inferred from sibling sheet' : '--year flag'})`);
    else if (!currentDate && timeColIdx >= 0 && !fallbackDate) undatedSheets.push(`${sheetName} -> SKIPPED, no year could be determined (pass --year=YYYY)`);
  }

  return { sheetsProcessed, rowsImported, undatedSheets };
}

function parseArgs(argv) {
  const files = [];
  let defaultYear = null;
  argv.forEach(a => {
    const m = a.match(/^--year=(\d{4})$/);
    if (m) defaultYear = m[1];
    else files.push(a);
  });
  return { files, defaultYear };
}

async function main() {
  const { files, defaultYear } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-leaching-history.js <workbook.xlsx> [more...] [--year=YYYY]');
    process.exit(1);
  }

  const skippedCols = new Set();
  let totalSheets = 0, totalRows = 0;
  const allUndated = [];
  for (const f of files) {
    console.log(`Processing ${f} ...`);
    const { sheetsProcessed, rowsImported, undatedSheets } = await processWorkbook(f, skippedCols, { defaultYear });
    console.log(`  ${sheetsProcessed} day-sheet(s), ${rowsImported} reading row(s) imported.`);
    totalSheets += sheetsProcessed;
    totalRows += rowsImported;
    allUndated.push(...undatedSheets);
  }

  if (allUndated.length) {
    console.log('\nSheets with no in-cell date (year inferred/handled as noted):');
    allUndated.forEach(s => console.log('  ' + s));
  }

  if (skippedCols.size) {
    console.log('\nColumns seen in the file(s) but NOT imported (unrecognized, or a tank outside LT4-LT10, e.g. always-empty LT1-3):');
    console.log('  ' + Array.from(skippedCols).sort().join(', '));
  }

  console.log(`\nDone. ${totalSheets} day-sheet(s), ${totalRows} reading row(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
