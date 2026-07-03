'use strict';

const { query } = require('./pool');
const { DB_START, SH, SHEET_PARAMS } = require('./config');
const { headersFor, parseDateValue } = require('./sheetUtils');
const typed = require('./typedTables');
const leaching = require('./leachingStore');

// ─── HEADERS (generic sheet_rows sheets only — typed sheets use typedTables) ──

// Headers change only on deploy or import, so a short in-process cache saves a
// round-trip per sheet per request (helps a lot on warm serverless instances).
const _headersCache = new Map(); // sheetName → { headers, ts }
const HEADERS_TTL_MS = 5 * 60 * 1000;

async function _ensureHeaders(sheetName) {
  const cached = _headersCache.get(sheetName);
  if (cached && Date.now() - cached.ts < HEADERS_TTL_MS) return cached.headers;

  const defined = headersFor(sheetName);
  let headers;
  if (defined) {
    await query(
      `INSERT INTO sheet_headers (sheet_name, headers) VALUES ($1, $2)
       ON CONFLICT (sheet_name) DO NOTHING`,
      [sheetName, JSON.stringify(defined)]
    );
    headers = defined;
  } else {
    const res = await query('SELECT headers FROM sheet_headers WHERE sheet_name = $1', [sheetName]);
    headers = res.rows[0] ? res.rows[0].headers : [];
  }
  _headersCache.set(sheetName, { headers, ts: Date.now() });
  return headers;
}

function invalidateHeaderCache(sheetName) {
  if (sheetName) _headersCache.delete(sheetName);
  else _headersCache.clear();
}

function _entryDateFromRow(headers, rowArray) {
  const idx = headers.findIndex(h => String(h).trim().toLowerCase() === 'date');
  if (idx < 0) return null;
  return parseDateValue(rowArray[idx]);
}

// ─── SHEET INTERFACE (drop-in for the old Google Sheets client) ───────────────
// Each function checks typed.isTyped(sheetName) first and delegates to the
// real-table implementation; everything else falls through to the original
// generic sheet_rows storage, completely unchanged.

/**
 * Returns all rows for a sheet as array-of-arrays, in insertion order.
 */
async function getSheet(sheetName) {
  if (leaching.isLeaching(sheetName)) return leaching.getRows(sheetName);
  if (typed.isTyped(sheetName)) return typed.getRows(sheetName);

  const res = await query(
    'SELECT row_data FROM sheet_rows WHERE sheet_name = $1 ORDER BY id ASC',
    [sheetName]
  );
  return res.rows.map(r => r.row_data);
}

/**
 * Returns rows filtered by date in SQL (indexed) instead of in JS.
 * filter: { date?: 'YYYY-MM-DD', month?: 'YYYY-MM', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
 * Rows whose entry_date could not be parsed are excluded when a filter is set.
 */
async function getSheetByDate(sheetName, filter = {}) {
  if (leaching.isLeaching(sheetName)) return leaching.getRowsByDate(sheetName, filter);
  if (typed.isTyped(sheetName)) return typed.getRowsByDate(sheetName, filter);

  const { date, month, from, to } = filter;
  const conds = ['sheet_name = $1'];
  const params = [sheetName];

  if (date) {
    params.push(date);
    conds.push(`entry_date = $${params.length}`);
  } else if (month) {
    params.push(`${month}-01`);
    conds.push(`entry_date >= $${params.length}::date`);
    conds.push(`entry_date < ($${params.length}::date + interval '1 month')`);
  } else if (from || to) {
    if (from) { params.push(from); conds.push(`entry_date >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`entry_date <= $${params.length}`); }
  }

  const res = await query(
    `SELECT row_data FROM sheet_rows WHERE ${conds.join(' AND ')} ORDER BY entry_date ASC NULLS LAST, id ASC`,
    params
  );
  return res.rows.map(r => r.row_data);
}

/**
 * Returns the header row as an array.
 */
async function getSheetHeaders(sheetName) {
  if (leaching.isLeaching(sheetName)) return leaching.getHeaders(sheetName);
  if (typed.isTyped(sheetName)) return typed.getHeaders(sheetName);
  return _ensureHeaders(sheetName);
}

/**
 * Returns all rows including headers as the first row (rarely used).
 */
async function getSheetFull(sheetName) {
  const headers = await getSheetHeaders(sheetName);
  const rows = await getSheet(sheetName);
  return [headers, ...rows];
}

/**
 * Appends a row to the sheet, extracting entry_date for indexed filtering.
 */
async function appendRow(sheetName, rowArray) {
  if (leaching.isLeaching(sheetName)) return leaching.appendRow(sheetName, rowArray);
  if (typed.isTyped(sheetName)) return typed.appendRow(sheetName, rowArray);

  const headers = await _ensureHeaders(sheetName);
  const entryDate = _entryDateFromRow(headers, rowArray);
  await query(
    'INSERT INTO sheet_rows (sheet_name, row_data, entry_date) VALUES ($1, $2, $3)',
    [sheetName, JSON.stringify(rowArray), entryDate]
  );
}

/**
 * Updates a specific row. rowNum matches the legacy Sheets numbering
 * (DB_START + index within getSheet's result order).
 */
async function updateRow(sheetName, rowNum, rowArray) {
  if (leaching.isLeaching(sheetName)) return leaching.updateRow(sheetName, rowNum, rowArray);
  if (typed.isTyped(sheetName)) return typed.updateRow(sheetName, rowNum, rowArray);

  const offset = rowNum - DB_START;
  if (offset < 0) throw new Error(`Invalid rowNum ${rowNum} for sheet ${sheetName}`);
  const headers = await _ensureHeaders(sheetName);
  const entryDate = _entryDateFromRow(headers, rowArray);
  await query(
    `UPDATE sheet_rows SET row_data = $1, entry_date = $2
     WHERE id = (
       SELECT id FROM sheet_rows WHERE sheet_name = $3 ORDER BY id ASC OFFSET $4 LIMIT 1
     )`,
    [JSON.stringify(rowArray), entryDate, sheetName, offset]
  );
}

/**
 * Updates a single cell. row is the legacy rowNum, col is 1-indexed column.
 * (Unused by the current app — kept for interface completeness.)
 */
async function updateCell(sheetName, row, col, value) {
  const rows = await getSheet(sheetName);
  const offset = row - DB_START;
  const rowArray = rows[offset];
  if (!rowArray) throw new Error(`Row ${row} not found in sheet ${sheetName}`);
  rowArray[col - 1] = value;
  await updateRow(sheetName, row, rowArray);
}

/**
 * Deletes every row in a sheet (used by the "replace" import mode).
 */
async function deleteAllRows(sheetName) {
  if (leaching.isLeaching(sheetName)) return leaching.deleteAllRows(sheetName);
  if (typed.isTyped(sheetName)) return typed.deleteAllRows(sheetName);
  await query('DELETE FROM sheet_rows WHERE sheet_name = $1', [sheetName]);
}

module.exports = {
  query, getSheet, getSheetByDate, getSheetHeaders, getSheetFull,
  appendRow, updateRow, updateCell, deleteAllRows,
  parseDateValue, invalidateHeaderCache,
};
