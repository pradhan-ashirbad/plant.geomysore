'use strict';

const { query } = require('./pool');
const { SH, DB_START } = require('./config');
const { columnDefsFor, parseDateValue } = require('./sheetUtils');

// Sheets migrated to a real, typed table so far. Add an entry here once a
// sheet's table has been created and its data migrated — everything else
// keeps working on the generic sheet_rows store until it's this sheet's turn.
const TYPED_TABLES = {
  [SH.CRUSHING]: 'crushing',
  [SH.FILTER]:   'filter_press',
};

// Typed tables whose natural key is the entry date (one row per day). For
// these, appendRow upserts on that column instead of always inserting — so a
// re-import or a same-day correction overwrites the existing row rather than
// creating a duplicate (matches the leaching/slurry normalized stores). The
// underlying table must have a UNIQUE constraint on the key column. Tables
// not listed here keep plain append-only behavior (e.g. Crushing).
const UPSERT_KEY = {
  [SH.FILTER]: 'entry_date',
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

// pg parses a 'date' column into a Date built from LOCAL y/m/d components
// (not UTC) — so it must be read back with local getters. Using
// toISOString() here converts to UTC first and rolls the date back a day
// whenever the process timezone is ahead of UTC (e.g. IST).
function _localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    if (d.sqlType === 'date' && v instanceof Date) return _localDateStr(v);
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
  const conflictKey = UPSERT_KEY[sheetName];

  if (conflictKey) {
    // Upsert: an incoming NULL never overwrites a stored value (COALESCE), so
    // a partial correction can't wipe fields it didn't touch — same rule the
    // leaching/slurry stores use.
    const updates = columns
      .filter(c => c !== conflictKey)
      .map(c => `${c} = COALESCE(EXCLUDED.${c}, ${table}.${c})`);
    await query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (${conflictKey}) DO UPDATE SET ${updates.join(', ')}`,
      values
    );
    return;
  }

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
