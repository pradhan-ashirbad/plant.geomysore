'use strict';
/**
 * One-time historical backfill for the Stoppage Reason log. Unlike the tank
 * sheets this is a flat event list, so it stays on the generic sheet_rows
 * store (via db.appendRow(SH.STOPPAGE, ...)) — no normalized table/adapter.
 *
 * Source layout (one "REASONS FOR STOPPAGE..." sheet):
 *   title row, header row (DATE, SECTION, STOP TIME, START TIME, DURATION,
 *   DEPARTMENT, REASON, REMARKS), then one row per stoppage. DATE and SECTION
 *   are only filled on the first row of each group and forward-filled down.
 *   DURATION is an Excel time-of-day value (HH:MM elapsed), except the odd
 *   full-day cell entered as the bare number 24.
 *
 * Usage:
 *   DATABASE_URL=... node db/migrate-stoppage-history.js <workbook.xlsx> [more...]
 */

require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../src/db');
const { SH } = require('../src/config');
const { columnDefsFor } = require('../src/sheetUtils');
const { dateToISO, loadWorkbook } = require('./_leachExcelUtils');

const STOP_HEADERS = columnDefsFor(SH.STOPPAGE).map(d => d.header);

function toWideRow(values) {
  return STOP_HEADERS.map(h => (values[h] !== undefined ? values[h] : ''));
}

// Excel time-of-day values come through (cellDates:true) as a Date built on
// the 1899-12-30 epoch — read HH:MM back with the UTC accessors. A duration
// > 24h rolls the day forward, so add whole days too.
function timeCellToHHMM(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  }
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function durationToHours(v) {
  if (v instanceof Date && !isNaN(v)) {
    const days = v.getUTCDate() - 30; // 1899-12-30 == 0 days
    return +(days * 24 + v.getUTCHours() + v.getUTCMinutes() / 60 + v.getUTCSeconds() / 3600).toFixed(3);
  }
  if (typeof v === 'number') return v;            // bare number (e.g. 24) = literal hours
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const cells = rows[i].map(c => String(c || '').trim().toLowerCase());
    if (cells.includes('date') && cells.includes('section')) return i;
  }
  return -1;
}

async function processWorkbook(input) {
  const wb = loadWorkbook(input);
  let rowsImported = 0;

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    const headerIdx = findHeaderRow(rows);
    if (headerIdx === -1) continue; // not a stoppage sheet

    const H = rows[headerIdx].map(c => String(c || '').trim().toLowerCase());
    const col = (name) => H.indexOf(name);
    const iDate = col('date'), iSec = col('section'), iStop = col('stop time'),
          iStart = col('start time'), iDur = col('duration'), iDept = col('department'),
          iReason = col('reason'), iRemarks = col('remarks');

    let curDate = null, curSection = null;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];

      const isoMaybe = dateToISO(row[iDate]);
      if (isoMaybe) curDate = isoMaybe;
      const secCell = String(row[iSec] || '').trim();
      if (secCell) curSection = secCell;

      const reason = String(row[iReason] || '').trim();
      const dept = String(row[iDept] || '').trim();
      const stop = timeCellToHHMM(row[iStop]);
      const start = timeCellToHHMM(row[iStart]);
      const hrs = durationToHours(row[iDur]);

      // A real stoppage row has a reason (and usually a dept/time). Skip the
      // title/blank/trailer rows that carry none of these.
      if (!reason && !dept && !stop && !start && (hrs === null || hrs === 0)) continue;
      if (!curDate) continue; // can't place a stoppage with no date

      const values = { Date: curDate };
      if (curSection) values['Section'] = curSection;
      if (stop) values['Stop Time'] = stop;
      if (start) values['Start Time'] = start;
      if (hrs !== null) values['Total Stoppage Hrs'] = hrs;
      if (dept) values['Department'] = dept;
      if (reason) values['Reason'] = reason;
      const remarks = iRemarks >= 0 ? String(row[iRemarks] || '').trim() : '';
      if (remarks) values['Action Taken'] = remarks;

      await db.appendRow(SH.STOPPAGE, toWideRow(values));
      rowsImported++;
    }
  }

  return { rowsImported };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: DATABASE_URL=... node db/migrate-stoppage-history.js <workbook.xlsx> [more...]');
    process.exit(1);
  }
  let total = 0;
  for (const f of files) {
    console.log(`Processing ${f} ...`);
    const { rowsImported } = await processWorkbook(f);
    console.log(`  ${rowsImported} stoppage row(s) imported.`);
    total += rowsImported;
  }
  console.log(`\nDone. ${total} stoppage row(s) imported in total.`);
  process.exit(0);
}

module.exports = { processWorkbook };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
