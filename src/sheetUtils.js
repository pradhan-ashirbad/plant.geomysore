'use strict';

const { SH, SHEET_PARAMS } = require('./config');

// Sheets with no SHEET_PARAMS entry get a fixed header list matching what
// data.js looks up by name (mirrors the generic sheet_rows storage).
const FIXED_HEADERS = {
  [SH.LIMITS]:   ['ID', 'Label', 'Prefix', 'Min', 'Max', 'Warn Min', 'Warn Max', 'Unit'],
  [SH.TARGETS]:  ['Month', 'Param ID', 'Param', 'Unit', 'Target', 'Notes', 'Set By', 'Updated'],
  [SH.CHEM_INV]: ['Chemical', 'Quantity', 'Unit', 'Min Stock', 'Reorder Level', 'Updated'],
};

function headersFor(sheetName) {
  if (FIXED_HEADERS[sheetName]) return FIXED_HEADERS[sheetName];
  const params = SHEET_PARAMS[sheetName];
  if (params && params.length) {
    return [...params.map(p => p.key), 'Submitted By', 'Timestamp'];
  }
  return null;
}

/**
 * Best-effort parse of a raw cell value into 'YYYY-MM-DD' (or null).
 * Handles ISO strings, DD/MM/YYYY, JS Dates, and Excel serial numbers.
 */
function parseDateValue(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const m2 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
    return null;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + v * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Turns a parameter key like "LT4 NaCN (ppm)" into a valid, readable
 * Postgres column name: "lt4_nacn_ppm".
 */
function sanitizeColumnName(key) {
  let s = String(key || '').toLowerCase();
  s = s.replace(/°/g, ''); // degree sign
  s = s.replace(/\//g, '_per_');
  s = s.replace(/[^a-z0-9]+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  s = s.replace(/_+/g, '_');
  return s || 'col';
}

/**
 * Builds the ordered column plan for a sheet: [{ header, column, sqlType }].
 * sqlType is one of 'date' | 'timestamptz' | 'text' | 'numeric'.
 * Throws if two headers sanitize to the same column name (should never
 * happen with the current config, but fail loudly instead of silently
 * clobbering data if it ever does).
 */
function columnDefsFor(sheetName) {
  const params = SHEET_PARAMS[sheetName] || [];
  const defs = params.map(p => {
    let sqlType = 'numeric';
    let column = sanitizeColumnName(p.key);
    if (p.key === 'Date') { sqlType = 'date'; column = 'entry_date'; }
    else if (p.isText || p.isTime || p.isSelect) sqlType = 'text';
    return { header: p.key, column, sqlType };
  });
  defs.push({ header: 'Submitted By', column: 'submitted_by', sqlType: 'text' });
  defs.push({ header: 'Timestamp', column: 'entry_timestamp', sqlType: 'timestamptz' });

  const seen = new Map();
  for (const d of defs) {
    if (seen.has(d.column)) {
      throw new Error(`Column name collision for sheet "${sheetName}": "${d.header}" and "${seen.get(d.column)}" both sanitize to "${d.column}"`);
    }
    seen.set(d.column, d.header);
  }
  return defs;
}

/**
 * Generates a CREATE TABLE statement for a sheet from its column plan.
 * Useful for producing migration SQL as each sheet is converted.
 */
function createTableSql(sheetName, tableName) {
  const defs = columnDefsFor(sheetName);
  const sqlTypeMap = { date: 'DATE', timestamptz: 'TIMESTAMPTZ', text: 'TEXT', numeric: 'NUMERIC' };
  const cols = defs.map(d => `  ${d.column} ${sqlTypeMap[d.sqlType]}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  id SERIAL PRIMARY KEY,\n${cols},\n  created_at TIMESTAMPTZ DEFAULT now()\n);\nCREATE INDEX IF NOT EXISTS idx_${tableName}_entry_date ON ${tableName} (entry_date);\n`;
}

module.exports = { headersFor, parseDateValue, sanitizeColumnName, columnDefsFor, createTableSql };
