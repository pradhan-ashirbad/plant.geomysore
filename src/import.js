'use strict';

const XLSX = require('xlsx');
const db = require('./db');
const { SH, SHEET_PARAMS } = require('./config');

const FIXED_HEADERS = {
  [SH.LIMITS]:   ['ID', 'Label', 'Prefix', 'Min', 'Max', 'Warn Min', 'Warn Max', 'Unit'],
  [SH.TARGETS]:  ['Month', 'Param ID', 'Param', 'Unit', 'Target', 'Notes', 'Set By', 'Updated'],
  [SH.CHEM_INV]: ['Chemical', 'Quantity', 'Unit', 'Min Stock', 'Reorder Level', 'Updated'],
};

function canonicalHeaders(sheetName) {
  if (FIXED_HEADERS[sheetName]) return FIXED_HEADERS[sheetName];
  const params = SHEET_PARAMS[sheetName];
  if (params && params.length) return [...params.map(p => p.key), 'Submitted By', 'Timestamp'];
  return null;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Maps an uploaded sheet's own header row to the app's canonical column
 * order for sheetName, so column order/naming in the Excel file doesn't
 * need to match exactly (same forgiving matching used for login headers).
 */
function buildColumnMapping(canonical, uploadedHeaders) {
  const normUploaded = uploadedHeaders.map(normalize);
  return canonical.map(target => {
    const normTarget = normalize(target);
    let idx = normUploaded.findIndex(h => h === normTarget);
    if (idx === -1) idx = normUploaded.findIndex(h => h.startsWith(normTarget) || normTarget.startsWith(h));
    return idx;
  });
}

/**
 * Parses an uploaded .xlsx/.csv buffer. Returns { headers, rows } where rows
 * is array-of-arrays matching the file's own header order (row 1 = headers).
 */
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!rows.length) return { headers: [], rows: [] };
  const [headers, ...dataRows] = rows;
  return { headers: headers.map(h => String(h || '').trim()), rows: dataRows.filter(r => r.some(c => c !== '' && c !== null && c !== undefined)) };
}

/**
 * Imports parsed rows into `sheetName`'s storage, aligning uploaded columns
 * to the app's canonical header order. mode: 'append' (default) or 'replace'.
 * Goes through db.js's public interface (getSheetHeaders/appendRow/
 * deleteAllRows) so this works identically whether the sheet is still on the
 * generic store or has been migrated to a real typed table.
 */
async function importIntoSheet(sheetName, uploadedHeaders, uploadedRows, mode = 'append') {
  const canonical = canonicalHeaders(sheetName);
  if (!canonical) throw new Error(`Unknown sheet: ${sheetName}`);

  const mapping = buildColumnMapping(canonical, uploadedHeaders);
  const matchedCount = mapping.filter(i => i !== -1).length;
  if (matchedCount === 0) {
    throw new Error('No columns in the uploaded file matched this sheet\'s expected columns.');
  }

  // Ensures generic-store sheets have a headers row; a no-op for typed
  // sheets (their headers come from the real table's column plan).
  await db.getSheetHeaders(sheetName);

  if (mode === 'replace') {
    await db.deleteAllRows(sheetName);
  }

  const dateIdx = canonical.findIndex(h => String(h).trim().toLowerCase() === 'date');
  let inserted = 0;
  for (const row of uploadedRows) {
    const mappedRow = mapping.map(idx => {
      if (idx === -1) return '';
      let v = row[idx];
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      return v === undefined || v === null ? '' : v;
    });
    if (dateIdx >= 0) {
      const entryDate = db.parseDateValue(mappedRow[dateIdx]);
      if (entryDate) mappedRow[dateIdx] = entryDate;
    }
    await db.appendRow(sheetName, mappedRow);
    inserted++;
  }
  db.invalidateHeaderCache(sheetName);

  return { matchedColumns: matchedCount, totalColumns: canonical.length, rowsInserted: inserted };
}

const IMPORTABLE_SHEETS = Object.keys(SHEET_PARAMS).filter(k => (SHEET_PARAMS[k] && SHEET_PARAMS[k].length) || FIXED_HEADERS[k]);

module.exports = { parseWorkbook, importIntoSheet, canonicalHeaders, IMPORTABLE_SHEETS };
