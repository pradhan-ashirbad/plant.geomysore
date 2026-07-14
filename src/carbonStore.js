'use strict';

/**
 * Storage adapter for Carbon in Leaching Tank. Two lab measurements per tank
 * per day: a carbon-weight set (Wet, Dry, C Tonnage = Dry × 0.38) and an
 * Au-on-carbon assay (ppm). Mirrors slurryStore.js/leachingStore.js: presents
 * the wide-row interface (getRows, getRowsByDate, getHeaders, appendRow,
 * updateRow, deleteAllRows) so db.js routes to it like a typed table, while
 * storage is a normalized "long format" table (one row per tank per day).
 *
 * The daily "Total C Dry Weight (Ton)" is NOT stored — it's the sum of the 7
 * tanks' C Tonnage, computed downstream by data.js display auto-calc.
 */

const { query } = require('./pool');
const { SH, CARBON_TANKS } = require('./config');
const { columnDefsFor } = require('./sheetUtils');

function isCarbon(sheetName) {
  return sheetName === SH.CARBON;
}

function _wideDefs() {
  return columnDefsFor(SH.CARBON);
}

function getHeaders(sheetName) {
  return _wideDefs().map(d => d.header);
}

let _tableEnsured = false;
async function _ensureTable() {
  if (_tableEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS carbon_readings (
    id SERIAL PRIMARY KEY,
    entry_date DATE NOT NULL,
    tank TEXT NOT NULL,
    wet NUMERIC,
    dry NUMERIC,
    c_tonnage NUMERIC,
    au NUMERIC,
    au_below_detection BOOLEAN DEFAULT false,
    notes TEXT,
    submitted_by TEXT,
    entry_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (entry_date, tank)
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_carbon_readings_date ON carbon_readings (entry_date)');
  _tableEnsured = true;
}

// Lab readings below detection show as e.g. "<0.05" — keep the threshold as
// the numeric value and flag it separately, same convention as slurryStore.js.
function parseDetectionValue(raw) {
  if (raw === '' || raw === null || raw === undefined) return { value: null, belowDetection: false };
  const s = String(raw).trim();
  const m = s.match(/^<\s*([\d.]+)\s*$/);
  if (m) return { value: parseFloat(m[1]), belowDetection: true };
  const n = parseFloat(s);
  return { value: isNaN(n) ? null : n, belowDetection: false };
}

function _numOrNull(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
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
  if (!entryDate) throw new Error('Carbon entry is missing a Date.');
  const notes = _textOrNull(byHeader['Notes']);
  const submittedBy = _textOrNull(byHeader['Submitted By']);
  const timestamp = _textOrNull(byHeader['Timestamp']);

  const rows = [];
  CARBON_TANKS.forEach(t => {
    const wet = _numOrNull(byHeader[`${t} Wet`]);
    const dry = _numOrNull(byHeader[`${t} Dry`]);
    const cTon = _numOrNull(byHeader[`${t} C Tonnage`]);
    const au = parseDetectionValue(byHeader[`${t} Au (ppm)`]);
    // Skip a tank only if it carries nothing this submission — so a partial
    // write (e.g. just the Au assay) never nulls out the weight columns.
    if (wet === null && dry === null && cTon === null && au.value === null) return;
    rows.push({ tank: t, wet, dry, cTonnage: cTon, au: au.value, auBelowDetection: au.belowDetection });
  });
  if (!rows.length) return;

  const params = [];
  const tuples = rows.map(r => {
    const base = params.length;
    params.push(entryDate, r.tank, r.wet, r.dry, r.cTonnage, r.au, r.auBelowDetection, notes, submittedBy, timestamp);
    return `(${Array.from({ length: 10 }, (_, i) => `$${base + i + 1}`).join(',')})`;
  });
  await query(
    `INSERT INTO carbon_readings (entry_date, tank, wet, dry, c_tonnage, au, au_below_detection, notes, submitted_by, entry_timestamp)
     VALUES ${tuples.join(',')}
     ON CONFLICT (entry_date, tank) DO UPDATE SET
       wet = COALESCE(EXCLUDED.wet, carbon_readings.wet),
       dry = COALESCE(EXCLUDED.dry, carbon_readings.dry),
       c_tonnage = COALESCE(EXCLUDED.c_tonnage, carbon_readings.c_tonnage),
       au = COALESCE(EXCLUDED.au, carbon_readings.au),
       au_below_detection = CASE WHEN EXCLUDED.au IS NOT NULL THEN EXCLUDED.au_below_detection ELSE carbon_readings.au_below_detection END,
       notes = COALESCE(EXCLUDED.notes, carbon_readings.notes),
       submitted_by = COALESCE(EXCLUDED.submitted_by, carbon_readings.submitted_by),
       entry_timestamp = COALESCE(EXCLUDED.entry_timestamp, carbon_readings.entry_timestamp)`,
    params
  );
}

async function updateRow(sheetName, rowNum, rowArray) {
  return appendRow(sheetName, rowArray);
}

// pg parses a 'date' column into a Date built from LOCAL y/m/d components
// (not UTC) — read it back with local getters so toISOString() (UTC) doesn't
// roll the date back a day when the process timezone is ahead of UTC (IST).
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
  const res = await query(`SELECT * FROM carbon_readings ${where} ORDER BY entry_date ASC`, params);

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
  CARBON_TANKS.forEach(t => {
    const r = g.byTank[t];
    byHeader[`${t} Wet`]       = r && r.wet !== null && r.wet !== undefined ? r.wet : '';
    byHeader[`${t} Dry`]       = r && r.dry !== null && r.dry !== undefined ? r.dry : '';
    byHeader[`${t} C Tonnage`] = r && r.c_tonnage !== null && r.c_tonnage !== undefined ? r.c_tonnage : '';
    byHeader[`${t} Au (ppm)`]  = r && r.au !== null && r.au !== undefined ? r.au : '';
  });
  byHeader['Notes'] = g.notes || '';
  byHeader['Submitted By'] = g.submittedBy || '';
  byHeader['Timestamp'] = g.timestamp ? new Date(g.timestamp).toISOString() : '';
  // 'Total C Dry Weight (Ton)' is left blank here — data.js display auto-calc
  // fills it as the sum of the 7 tanks' C Tonnage.
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
  await query('DELETE FROM carbon_readings');
}

module.exports = {
  isCarbon, getRows, getRowsByDate, getHeaders, appendRow, updateRow, deleteAllRows,
  parseDetectionValue, _groupToWideRow, _wideDefs,
};
