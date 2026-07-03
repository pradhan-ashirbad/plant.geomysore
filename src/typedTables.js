'use strict';

const { query } = require('./pool');
const { SH, DB_START } = require('./config');
const { columnDefsFor, parseDateValue } = require('./sheetUtils');

// Sheets migrated to a real, typed table so far. Add an entry here once a
// sheet's table has been created and its data migrated — everything else
// keeps working on the generic sheet_rows store until it's this sheet's turn.
const TYPED_TABLES = {
  [SH.CRUSHING]: 'crushing',
};

function isTyped(sheetName) {
  return !!TYPED_TABLES[sheetName];
}

function _coerce(value, sqlType) {
  if (value === '' || value === null || value === undefined) return null;
  if (sqlType === 'date') return parseDateValue(value) || value;
  if (sqlType === 'numeric') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return value; // text, timestamptz (Postgres parses ISO strings fine)
}

/**
 * Converts a legacy header-ordered row array into { column: value } using
 * the sheet's column plan.
 */
function _rowArrayToObject(sheetName, rowArray) {
  const defs = columnDefsFor(sheetName);
  const obj = {};
  defs.forEach((d, i) => { obj[d.column] = _coerce(rowArray[i], d.sqlType); });
  return obj;
}

/**
 * Converts a DB row (column: value) back into the legacy header-ordered
 * array data.js expects, so no other code needs to change.
 */
function _dbRowToArray(sheetName, dbRow) {
  const defs = columnDefsFor(sheetName);
  return defs.map(d => {
    const v = dbRow[d.column];
    if (v === null || v === undefined) return '';
    if (d.sqlType === 'date' && v instanceof Date) return v.toISOString().slice(0, 10);
    if (d.sqlType === 'timestamptz' && v instanceof Date) return v.toISOString();
    return v;
  });
}

async function getRows(sheetName) {
  const table = TYPED_TABLES[sheetName];
  const res = await query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return res.rows.map(r => _dbRowToArray(sheetName, r));
}

async function getRowsByDate(sheetName, filter = {}) {
  const table = TYPED_TABLES[sheetName];
  const { date, month, from, to } = filter;
  const conds = [];
  const params = [];

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

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await query(
    `SELECT * FROM ${table} ${where} ORDER BY entry_date ASC NULLS LAST, id ASC`,
    params
  );
  return res.rows.map(r => _dbRowToArray(sheetName, r));
}

function getHeaders(sheetName) {
  return columnDefsFor(sheetName).map(d => d.header);
}

async function appendRow(sheetName, rowArray) {
  const table = TYPED_TABLES[sheetName];
  const obj = _rowArrayToObject(sheetName, rowArray);
  const columns = Object.keys(obj);
  const values = columns.map(c => obj[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  await query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values
  );
}

async function updateRow(sheetName, rowNum, rowArray) {
  const table = TYPED_TABLES[sheetName];
  const offset = rowNum - DB_START;
  if (offset < 0) throw new Error(`Invalid rowNum ${rowNum} for sheet ${sheetName}`);
  const obj = _rowArrayToObject(sheetName, rowArray);
  const columns = Object.keys(obj);
  const values = columns.map(c => obj[c]);
  const setClauses = columns.map((c, i) => `${c} = $${i + 1}`);
  await query(
    `UPDATE ${table} SET ${setClauses.join(', ')}
     WHERE id = (SELECT id FROM ${table} ORDER BY id ASC OFFSET $${values.length + 1} LIMIT 1)`,
    [...values, offset]
  );
}

async function deleteAllRows(sheetName) {
  const table = TYPED_TABLES[sheetName];
  await query(`DELETE FROM ${table}`);
}

module.exports = { TYPED_TABLES, isTyped, getRows, getRowsByDate, getHeaders, appendRow, updateRow, deleteAllRows };
