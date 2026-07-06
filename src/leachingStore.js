'use strict';

/**
 * Storage adapter for Leaching (LT4-LT10) and Detox (DT1-DT4) tank readings.
 *
 * Presents the exact same interface as typedTables.js (getRows,
 * getRowsByDate, getHeaders, appendRow, updateRow, deleteAllRows) so db.js
 * can route to it exactly like a typed table — but internally it's backed by
 * two normalized "long format" tables (one row per tank per reading) instead
 * of one row per timestamp. appendRow splits an incoming wide legacy row
 * (Date, Time, "LT4 NaCN (ppm)", "LT4 pH", ... "DT4 Au in Liquor (ppm)")
 * into per-tank upserts; getRows/getRowsByDate pivot the normalized rows
 * back into that same wide shape, so nothing else in the app (data.js,
 * app.js's heatmap/tank-profile/trend code) needs to change.
 */

const { query } = require('./pool');
const { SH, LT_TANKS, DT_TANKS, LEACH_TIMES } = require('./config');
const { columnDefsFor } = require('./sheetUtils');

// DT1/DT4 are the historically-monitored feed/outlet points; DT2/DT3 have no
// established role yet (no historical data references them).
const DT_ROLE = { DT1: 'feed', DT4: 'outlet' };

// Create the two tables on first use so the app works even if
// db/migrate-003-leaching-tables.sql was never run in Supabase's SQL
// Editor — a missing table otherwise fails every Leaching read/write
// with "relation does not exist".
let _tablesEnsured = false;
async function _ensureTables() {
  if (_tablesEnsured) return;
  await query(`CREATE TABLE IF NOT EXISTS leaching_readings (
    id SERIAL PRIMARY KEY,
    entry_date DATE NOT NULL,
    time_slot TEXT NOT NULL,
    tank TEXT NOT NULL,
    nacn NUMERIC,
    nacn_below_detection BOOLEAN DEFAULT false,
    ph NUMERIC,
    dissolved_oxygen NUMERIC,
    au NUMERIC,
    au_below_detection BOOLEAN DEFAULT false,
    overflow TEXT,
    notes TEXT,
    submitted_by TEXT,
    entry_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (entry_date, time_slot, tank)
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_leaching_readings_date ON leaching_readings (entry_date)');
  await query(`CREATE TABLE IF NOT EXISTS detox_readings (
    id SERIAL PRIMARY KEY,
    entry_date DATE NOT NULL,
    time_slot TEXT NOT NULL,
    tank TEXT NOT NULL,
    role TEXT,
    nacn NUMERIC,
    nacn_below_detection BOOLEAN DEFAULT false,
    ph NUMERIC,
    au NUMERIC,
    au_below_detection BOOLEAN DEFAULT false,
    notes TEXT,
    submitted_by TEXT,
    entry_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (entry_date, time_slot, tank)
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_detox_readings_date ON detox_readings (entry_date)');
  _tablesEnsured = true;
}

function isLeaching(sheetName) {
  return sheetName === SH.LEACHING;
}

function _wideDefs() {
  return columnDefsFor(SH.LEACHING);
}

function getHeaders(sheetName) {
  return _wideDefs().map(d => d.header);
}

// Rounds any given time to the nearest of the 6 fixed 4-hourly slots
// (03:00, 07:00, 11:00, 15:00, 19:00, 23:00), circularly across midnight.
// The live entry form only ever sends one of these exact values already;
// this mainly protects the historical import (where a logged time might be
// a few minutes off) and any future free-text time entry.
const SLOT_HOURS = LEACH_TIMES.map(t => parseInt(t.split(':')[0], 10));

function nearestSlot(timeVal) {
  let hour = SLOT_HOURS[0];
  let minute = 0;
  if (timeVal instanceof Date && !isNaN(timeVal)) {
    hour = timeVal.getHours();
    minute = timeVal.getMinutes();
  } else {
    const m = String(timeVal || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (m) { hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); }
  }
  const t = hour + minute / 60;
  let best = SLOT_HOURS[0];
  let bestDist = Infinity;
  SLOT_HOURS.forEach(h => {
    const raw = Math.abs(t - h);
    const dist = Math.min(raw, 24 - raw);
    if (dist < bestDist) { bestDist = dist; best = h; }
  });
  return `${String(best).padStart(2, '0')}:00`;
}

// Lab readings below the instrument's detection limit are logged as e.g.
// "<0.3" or "<0.03". We keep the threshold as the numeric value (so every
// existing numeric consumer — limit checks, averages, charts — keeps
// working unchanged) and separately flag it as below-detection for any
// future UI that wants to show a "BDL" badge.
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

/**
 * Splits one wide legacy row into per-tank candidate readings. A tank is
 * only included if at least one of its fields was actually filled in this
 * submission — this matters because a single Leaching entry-form submission
 * may only cover some of the 11 tanks (a sensor was down, an operator only
 * had time for some tanks that round, etc.); skipping empty tanks means we
 * never clobber an existing good reading with blanks.
 */
function _splitWideRow(byHeader) {
  const entryDate = _textOrNull(byHeader['Date']);
  const timeSlot = nearestSlot(byHeader['Time']);
  const notes = _textOrNull(byHeader['Notes']);
  const submittedBy = _textOrNull(byHeader['Submitted By']);
  const timestamp = _textOrNull(byHeader['Timestamp']);

  const leach = [];
  LT_TANKS.forEach(t => {
    const nacn = parseDetectionValue(byHeader[`${t} NaCN (ppm)`]);
    const ph = _numOrNull(byHeader[`${t} pH`]);
    const dox = _numOrNull(byHeader[`${t} DO (ppm)`]);
    const au = parseDetectionValue(byHeader[`${t} Au in Liquor (ppm)`]);
    const overflow = _textOrNull(byHeader[`${t} Overflow`]);
    if (nacn.value === null && ph === null && dox === null && au.value === null && overflow === null) return;
    leach.push({
      tank: t, nacn: nacn.value, nacnBelowDetection: nacn.belowDetection,
      ph, dissolvedOxygen: dox, au: au.value, auBelowDetection: au.belowDetection, overflow,
    });
  });

  const detox = [];
  DT_TANKS.forEach(t => {
    const nacn = parseDetectionValue(byHeader[`${t} NaCN (ppm)`]);
    const ph = _numOrNull(byHeader[`${t} pH`]);
    const au = parseDetectionValue(byHeader[`${t} Au in Liquor (ppm)`]);
    if (nacn.value === null && ph === null && au.value === null) return;
    detox.push({
      tank: t, role: DT_ROLE[t] || null,
      nacn: nacn.value, nacnBelowDetection: nacn.belowDetection,
      ph, au: au.value, auBelowDetection: au.belowDetection,
    });
  });

  return { entryDate, timeSlot, notes, submittedBy, timestamp, leach, detox };
}

async function appendRow(sheetName, rowArray) {
  await _ensureTables();
  const defs = _wideDefs();
  const byHeader = {};
  defs.forEach((d, i) => { byHeader[d.header] = rowArray[i]; });

  const { entryDate, timeSlot, notes, submittedBy, timestamp, leach, detox } = _splitWideRow(byHeader);
  if (!entryDate) throw new Error('Leaching entry is missing a Date.');

  // One multi-row upsert per table instead of one round-trip per tank —
  // the historical backfill pushes hundreds of readings through here, and
  // per-tank queries from a serverless function to Supabase add up to
  // minutes of wall-clock (long enough to time the request out).
  if (leach.length) {
    const params = [];
    const tuples = leach.map(r => {
      const base = params.length;
      params.push(entryDate, timeSlot, r.tank, r.nacn, r.nacnBelowDetection, r.ph, r.dissolvedOxygen, r.au, r.auBelowDetection, r.overflow, notes, submittedBy, timestamp);
      return `(${Array.from({ length: 13 }, (_, i) => `$${base + i + 1}`).join(',')})`;
    });
    await query(
      `INSERT INTO leaching_readings
         (entry_date, time_slot, tank, nacn, nacn_below_detection, ph, dissolved_oxygen, au, au_below_detection, overflow, notes, submitted_by, entry_timestamp)
       VALUES ${tuples.join(',')}
       ON CONFLICT (entry_date, time_slot, tank) DO UPDATE SET
         nacn = COALESCE(EXCLUDED.nacn, leaching_readings.nacn),
         nacn_below_detection = CASE WHEN EXCLUDED.nacn IS NOT NULL THEN EXCLUDED.nacn_below_detection ELSE leaching_readings.nacn_below_detection END,
         ph = COALESCE(EXCLUDED.ph, leaching_readings.ph),
         dissolved_oxygen = COALESCE(EXCLUDED.dissolved_oxygen, leaching_readings.dissolved_oxygen),
         au = COALESCE(EXCLUDED.au, leaching_readings.au),
         au_below_detection = CASE WHEN EXCLUDED.au IS NOT NULL THEN EXCLUDED.au_below_detection ELSE leaching_readings.au_below_detection END,
         overflow = COALESCE(EXCLUDED.overflow, leaching_readings.overflow),
         notes = COALESCE(EXCLUDED.notes, leaching_readings.notes),
         submitted_by = COALESCE(EXCLUDED.submitted_by, leaching_readings.submitted_by),
         entry_timestamp = COALESCE(EXCLUDED.entry_timestamp, leaching_readings.entry_timestamp)`,
      params
    );
  }

  if (detox.length) {
    const params = [];
    const tuples = detox.map(r => {
      const base = params.length;
      params.push(entryDate, timeSlot, r.tank, r.role, r.nacn, r.nacnBelowDetection, r.ph, r.au, r.auBelowDetection, notes, submittedBy, timestamp);
      return `(${Array.from({ length: 12 }, (_, i) => `$${base + i + 1}`).join(',')})`;
    });
    await query(
      `INSERT INTO detox_readings
         (entry_date, time_slot, tank, role, nacn, nacn_below_detection, ph, au, au_below_detection, notes, submitted_by, entry_timestamp)
       VALUES ${tuples.join(',')}
       ON CONFLICT (entry_date, time_slot, tank) DO UPDATE SET
         role = COALESCE(EXCLUDED.role, detox_readings.role),
         nacn = COALESCE(EXCLUDED.nacn, detox_readings.nacn),
         nacn_below_detection = CASE WHEN EXCLUDED.nacn IS NOT NULL THEN EXCLUDED.nacn_below_detection ELSE detox_readings.nacn_below_detection END,
         ph = COALESCE(EXCLUDED.ph, detox_readings.ph),
         au = COALESCE(EXCLUDED.au, detox_readings.au),
         au_below_detection = CASE WHEN EXCLUDED.au IS NOT NULL THEN EXCLUDED.au_below_detection ELSE detox_readings.au_below_detection END,
         notes = COALESCE(EXCLUDED.notes, detox_readings.notes),
         submitted_by = COALESCE(EXCLUDED.submitted_by, detox_readings.submitted_by),
         entry_timestamp = COALESCE(EXCLUDED.entry_timestamp, detox_readings.entry_timestamp)`,
      params
    );
  }
}

// Note on the COALESCE upserts above: re-submitting a reading merges with
// whatever is already stored rather than replacing it wholesale, so a
// partial write (e.g. the DO-only mini-table in the historical logs, or a
// correction that only fills some tanks) never nulls out fields it didn't
// touch. The entry form only ever sends filled-in fields, so this never
// prevents a genuine edit.

// Corrections to an already-submitted reading go through the same upsert
// path as a fresh submission — the (entry_date, time_slot, tank) unique key
// means resubmitting just overwrites the prior values for whichever tanks
// are present in the new rowArray.
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
  await _ensureTables();
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
  const [leachRes, detoxRes] = await Promise.all([
    query(`SELECT * FROM leaching_readings ${where} ORDER BY entry_date ASC, time_slot ASC`, params),
    query(`SELECT * FROM detox_readings ${where} ORDER BY entry_date ASC, time_slot ASC`, params),
  ]);

  const groups = new Map(); // "date|slot" -> { date, slot, leach: {tank: row}, detox: {tank: row}, notes, submittedBy, timestamp }
  const touch = (r) => {
    const key = `${_dateStr(r.entry_date)}|${r.time_slot}`;
    if (!groups.has(key)) {
      groups.set(key, { date: _dateStr(r.entry_date), slot: r.time_slot, leach: {}, detox: {}, notes: null, submittedBy: null, timestamp: null });
    }
    const g = groups.get(key);
    if (r.notes) g.notes = r.notes;
    if (r.submitted_by) g.submittedBy = r.submitted_by;
    if (r.entry_timestamp) g.timestamp = r.entry_timestamp;
    return g;
  };

  leachRes.rows.forEach(r => { touch(r).leach[r.tank] = r; });
  detoxRes.rows.forEach(r => { touch(r).detox[r.tank] = r; });

  return Array.from(groups.values()).sort((a, b) =>
    a.date === b.date ? a.slot.localeCompare(b.slot) : a.date.localeCompare(b.date)
  );
}

function _fmtReading(value) {
  return value === null || value === undefined ? '' : value;
}

function _groupToWideRow(g) {
  const defs = _wideDefs();
  const byHeader = {};
  byHeader['Date'] = g.date;
  byHeader['Time'] = g.slot;

  LT_TANKS.forEach(t => {
    const r = g.leach[t];
    byHeader[`${t} NaCN (ppm)`] = r ? _fmtReading(r.nacn) : '';
    byHeader[`${t} pH`] = r ? _fmtReading(r.ph) : '';
    byHeader[`${t} DO (ppm)`] = r ? _fmtReading(r.dissolved_oxygen) : '';
    byHeader[`${t} Au in Liquor (ppm)`] = r ? _fmtReading(r.au) : '';
    byHeader[`${t} Overflow`] = r && r.overflow ? r.overflow : '';
  });

  DT_TANKS.forEach(t => {
    const r = g.detox[t];
    byHeader[`${t} NaCN (ppm)`] = r ? _fmtReading(r.nacn) : '';
    byHeader[`${t} pH`] = r ? _fmtReading(r.ph) : '';
    byHeader[`${t} Au in Liquor (ppm)`] = r ? _fmtReading(r.au) : '';
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
  await _ensureTables();
  await query('DELETE FROM leaching_readings');
  await query('DELETE FROM detox_readings');
}

module.exports = {
  isLeaching, getRows, getRowsByDate, getHeaders, appendRow, updateRow, deleteAllRows,
  // exported for the historical import scripts and unit tests
  nearestSlot, parseDetectionValue, _splitWideRow, _groupToWideRow, _wideDefs,
};
