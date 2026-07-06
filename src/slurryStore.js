'use strict';

/**
 * Storage adapter for Slurry Samples ("Au in Solids" — one Au ppm reading
 * per tank per day, no time-slot). Mirrors leachingStore.js's design:
 * presents the same wide-row interface (getRows, getRowsByDate, getHeaders,
 * appendRow, updateRow, deleteAllRows) so db.js can route to it exactly
 * like a typed table, while storage is a normalized "long format" table
 * (one row per tank per day) instead of one ~13-column row per date.
 */

const { query } = require('./pool');
const { SH, SLURRY_AU_TANKS } = require('./config');
const { columnDefsFor } = require('./sheetUtils');

function isSlurry(sheetName) {
  return sheetName === SH.SLURRY;
}

function _wideDefs() {
  return columnDefsFor(SH.SLURRY);
}

function getHeaders(sheetName) {
  return _wideDefs().map(d => d.header);
}

let _tableEnsured = false;
async function _ensureTable() {
  if (_tableEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS slurry_readings (
    id SERIAL PRIMARY KEY,
    entry_date DATE NOT NULL,
    tank TEXT NOT NULL,
    au NUMERIC,
    au_below_detection BOOLEAN DEFAULT false,
    notes TEXT,
    submitted_by TEXT,
    entry_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (entry_date, tank)
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_slurry_readings_date ON slurry_readings (entry_date)');
  _tableEnsured = true;
}

// Lab readings below detection show as e.g. "<0.05" — keep the threshold as
// the numeric value (so every numeric consumer keeps working) and flag it
// separately, same convention as leachingStore.js.
function parseDetectionValue(raw) {
  if (raw === '' || raw === null || raw === undefined) return { value: null, belowDetection: false };
  const s = String(raw).trim();
  const m = s.match(/^<\s*([\d.]+)\s*$/);
  if (m) return { value: parseFloat(m[1]), belowDetection: true };
  const n = parseFloat(s);
  return { value: isNaN(n) ? null : n, belowDetection: false };
}

function _textOrNull(raw) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  return s === '' ? null : s;
}

async function appendRow(sheetName, rowArray) {
  await _ensureTable();
  const defs = _wideDefs();
  const byHeader = {};
  defs.forEach((d, i) => { byHeader[d.header] = rowArray[i]; });

  const entryDate = _textOrNull(byHeader['Date']);
  if (!entryDate) throw new Error('Slurry entry is missing a Date.');
  const notes = _textOrNull(byHeader['Notes']);
  const submittedBy = _textOrNull(byHeader['Submitted By']);
  const timestamp = _textOrNull(byHeader['Timestamp']);

  const rows = [];
  SLURRY_AU_TANKS.forEach(t => {
    const au = parseDetectionValue(byHeader[`${t} Au (ppm)`]);
    if (au.value === null) return; // skip tanks with no value this submission
    rows.push({ tank: t, au: au.value, auBelowDetection: au.belowDetection });
  });
  if (!rows.length) return;

  const params = [];
  const tuples = rows.map(r => {
    const base = params.length;
    params.push(entryDate, r.tank, r.au, r.auBelowDetection, notes, submittedBy, timestamp);
    return `(${Array.from({ length: 7 }, (_, i) => `$${base + i + 1}`).join(',')})`;
  });
  await query(
    `INSERT INTO slurry_readings (entry_date, tank, au, au_below_detection, notes, submitted_by, entry_timestamp)
     VALUES ${tuples.join(',')}
     ON CONFLICT (entry_date, tank) DO UPDATE SET
       au = COALESCE(EXCLUDED.au, slurry_readings.au),
       au_below_detection = CASE WHEN EXCLUDED.au IS NOT NULL THEN EXCLUDED.au_below_detection ELSE slurry_readings.au_below_detection END,
       notes = COALESCE(EXCLUDED.notes, slurry_readings.notes),
       submitted_by = COALESCE(EXCLUDED.submitted_by, slurry_readings.submitted_by),
       entry_timestamp = COALESCE(EXCLUDED.entry_timestamp, slurry_readings.entry_timestamp)`,
    params
  );
}

async function updateRow(sheetName, rowNum, rowArray) {
  return appendRow(sheetName, rowArray);
}

// pg parses a 'date' column into a Date built from LOCAL y/m/d components
// (not UTC) — so it must be read back with local getters. toISOString()
// converts to UTC first and rolls the date back a day whenever the process
// timezone is ahead of UTC (e.g. IST).
function _dateStr(d) {
  if (!(d instanceof Date)) return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function _fetchGroups(filter = {}) {
  await _ensureTable();
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
  const res = await query(`SELECT * FROM slurry_readings ${where} ORDER BY entry_date ASC`, params);

  const groups = new Map(); // date -> { date, byTank, notes, submittedBy, timestamp }
  res.rows.forEach(r => {
    const d = _dateStr(r.entry_date);
    if (!groups.has(d)) groups.set(d, { date: d, byTank: {}, notes: null, submittedBy: null, timestamp: null });
    const g = groups.get(d);
    g.byTank[r.tank] = r;
    if (r.notes) g.notes = r.notes;
    if (r.submitted_by) g.submittedBy = r.submitted_by;
    if (r.entry_timestamp) g.timestamp = r.entry_timestamp;
  });

  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function _groupToWideRow(g) {
  const defs = _wideDefs();
  const byHeader = { Date: g.date };
  SLURRY_AU_TANKS.forEach(t => {
    const r = g.byTank[t];
    byHeader[`${t} Au (ppm)`] = r && r.au !== null ? r.au : '';
  });
  byHeader['Notes'] = g.notes || '';
  byHeader['Submitted By'] = g.submittedBy || '';
  byHeader['Timestamp'] = g.timestamp ? new Date(g.timestamp).toISOString() : '';
  return defs.map(d => (byHeader[d.header] !== undefined ? byHeader[d.header] : ''));
}

async function getRows(sheetName) {
  const groups = await _fetchGroups({});
  return groups.map(_groupToWideRow);
}

async function getRowsByDate(sheetName, filter = {}) {
  const groups = await _fetchGroups(filter);
  return groups.map(_groupToWideRow);
}

async function deleteAllRows(sheetName) {
  await _ensureTable();
  await query('DELETE FROM slurry_readings');
}

module.exports = {
  isSlurry, getRows, getRowsByDate, getHeaders, appendRow, updateRow, deleteAllRows,
  parseDetectionValue, _groupToWideRow, _wideDefs,
};
