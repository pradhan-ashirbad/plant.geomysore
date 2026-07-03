'use strict';
// Shared parsing helpers for the Leaching + Detox historical import scripts.
// The source workbooks are one-sheet-per-day with headers that vary from
// sheet to sheet (different tank sets, missing Au, an extra Shift/Operator
// layout in some months) — so these helpers read each sheet's own header
// row and column names dynamically instead of assuming a fixed layout.

const CANON_PARAM = [
  [/^nacn\b/i, 'NaCN (ppm)'],
  [/^cn\b/i,   'NaCN (ppm)'],
  [/^ph\b/i,   'pH'],
  [/^au\b/i,   'Au in Liquor (ppm)'],
  [/^do\b/i,   'DO (ppm)'],
];

function canonParam(label) {
  const norm = String(label || '').replace(/\s+/g, ' ').trim();
  for (const [re, canon] of CANON_PARAM) if (re.test(norm)) return canon;
  return null;
}

// "LT7 CN (ppm)" -> { tank: 'LT7', paramRaw: 'CN (ppm)' }
// "Detox T1 Feed CN (ppm)" -> { tank: 'DT1', paramRaw: 'CN (ppm)' }
function parseTankColumn(header) {
  const h = String(header || '').replace(/\s+/g, ' ').trim();
  let m = h.match(/^Detox\s+T(\d)\s+(?:Feed|Outlet)\s+(.+)$/i);
  if (m) return { tank: `DT${m[1]}`, paramRaw: m[2] };
  m = h.match(/^(LT\d{1,2}|DT\d)\s+(.+)$/i);
  if (m) return { tank: m[1].toUpperCase(), paramRaw: m[2] };
  return null;
}

// Excel time-of-day cells come through (with cellDates:true) as JS Date
// objects built from UTC components (e.g. 1899-12-30T03:00:00.000Z for
// 3:00 AM) regardless of the host machine's timezone — read them back with
// the UTC accessors so the import is correct on any machine.
function timeToHHMM(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  }
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function dateToISO(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/); // DD.MM.YYYY or DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}

function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    if (rows[i].some(c => String(c || '').trim().toLowerCase() === 'date')) return i;
  }
  return -1;
}

module.exports = { canonParam, parseTankColumn, timeToHHMM, dateToISO, findHeaderRowIndex };
