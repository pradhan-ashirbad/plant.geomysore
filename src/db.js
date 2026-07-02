'use strict';

const { Pool } = require('pg');
const { DB_START, SH, SHEET_PARAMS } = require('./config');

let _pool = null;
function _getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set');
  _pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return _pool;
}

function query(text, params) {
  return _getPool().query(text, params);
}

// ─── HEADER DEFINITIONS ───────────────────────────────────────────────────────
// Sheets driven by SHEET_PARAMS get their headers from there (plus bookkeeping
// columns). Sheets with no SHEET_PARAMS entry (LIMITS/TARGETS/CHEM_INV) get a
// fixed header list matching what data.js looks up by name.

const _FIXED_HEADERS = {
  [SH.LIMITS]:   ['ID', 'Label', 'Prefix', 'Min', 'Max', 'Warn Min', 'Warn Max', 'Unit'],
  [SH.TARGETS]:  ['Month', 'Param ID', 'Param', 'Unit', 'Target', 'Notes', 'Set By', 'Updated'],
  [SH.CHEM_INV]: ['Chemical', 'Quantity', 'Unit', 'Min Stock', 'Reorder Level', 'Updated'],
};

function _headersFor(sheetName) {
  if (_FIXED_HEADERS[sheetName]) return _FIXED_HEADERS[sheetName];
  const params = SHEET_PARAMS[sheetName];
  if (params && params.length) {
    return [...params.map(p => p.key), 'Submitted By', 'Timestamp'];
  }
  return null; // unknown sheet — headers must already exist in sheet_headers table
}

async function _ensureHeaders(sheetName) {
  const defined = _headersFor(sheetName);
  if (defined) {
    await query(
      `INSERT INTO sheet_headers (sheet_name, headers) VALUES ($1, $2)
       ON CONFLICT (sheet_name) DO NOTHING`,
      [sheetName, JSON.stringify(defined)]
    );
    return defined;
  }
  const res = await query('SELECT headers FROM sheet_headers WHERE sheet_name = $1', [sheetName]);
  return res.rows[0] ? res.rows[0].headers : [];
}

/**
 * Returns all rows for a sheet as array-of-arrays, in insertion order.
 */
async function getSheet(sheetName) {
  const res = await query(
    'SELECT row_data FROM sheet_rows WHERE sheet_name = $1 ORDER BY id ASC',
    [sheetName]
  );
  return res.rows.map(r => r.row_data);
}

/**
 * Returns the header row as an array.
 */
async function getSheetHeaders(sheetName) {
  return _ensureHeaders(sheetName);
}

/**
 * Returns all rows including headers as the first row (rarely used).
 */
async function getSheetFull(sheetName) {
  const headers = await _ensureHeaders(sheetName);
  const rows = await getSheet(sheetName);
  return [headers, ...rows];
}

/**
 * Appends a row to the sheet.
 */
async function appendRow(sheetName, rowArray) {
  await _ensureHeaders(sheetName);
  await query(
    'INSERT INTO sheet_rows (sheet_name, row_data) VALUES ($1, $2)',
    [sheetName, JSON.stringify(rowArray)]
  );
}

/**
 * Updates a specific row. rowNum matches the legacy Sheets numbering
 * (DB_START + index within getSheet's result order).
 */
async function updateRow(sheetName, rowNum, rowArray) {
  const offset = rowNum - DB_START;
  if (offset < 0) throw new Error(`Invalid rowNum ${rowNum} for sheet ${sheetName}`);
  await query(
    `UPDATE sheet_rows SET row_data = $1
     WHERE id = (
       SELECT id FROM sheet_rows WHERE sheet_name = $2 ORDER BY id ASC OFFSET $3 LIMIT 1
     )`,
    [JSON.stringify(rowArray), sheetName, offset]
  );
}

/**
 * Updates a single cell. row is the legacy rowNum, col is 1-indexed column.
 */
async function updateCell(sheetName, row, col, value) {
  const rows = await getSheet(sheetName);
  const offset = row - DB_START;
  const rowArray = rows[offset];
  if (!rowArray) throw new Error(`Row ${row} not found in sheet ${sheetName}`);
  rowArray[col - 1] = value;
  await updateRow(sheetName, row, rowArray);
}

module.exports = { query, getSheet, getSheetHeaders, getSheetFull, appendRow, updateRow, updateCell };
