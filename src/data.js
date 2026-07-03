'use strict';

const {
  DB_START, SH, LT_TANKS, DT_TANKS, CARBON_TANKS,
  SECTIONS, SHEET_PARAMS, SECTION_CHEMICALS, ROLE_CONFIG,
  SECTION_GROUPS, HIDDEN_FROM_DASHBOARD, GROUP_TAB_LABELS,
  canWrite, canSeeSection, canManageTargets,
} = require('./config');
const { validateSession } = require('./auth');

// ─── COLUMN MAP HELPERS ───────────────────────────────────────────────────────

function buildColMap(headers) {
  const map = {};
  if (!Array.isArray(headers)) return map;
  headers.forEach((h, i) => { if (h !== null && h !== undefined && String(h).trim()) map[String(h).trim()] = i; });
  return map;
}

function findColIndex(colMap, key) {
  if (colMap[key] !== undefined) return colMap[key];
  const k = String(key).toLowerCase();
  for (const h of Object.keys(colMap)) {
    if (h.toLowerCase().startsWith(k)) return colMap[h];
  }
  return -1;
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function _toIsoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // Try DD/MM/YYYY
    const m2 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    return v;
  }
  if (typeof v === 'number') {
    // Google Sheets serial date
    const msPerDay = 86400000;
    const epoch = new Date(1899, 11, 30);
    const date = new Date(epoch.getTime() + v * msPerDay);
    return date.toISOString().slice(0, 10);
  }
  return String(v);
}

function _getYearMonth(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).slice(0, 7); // YYYY-MM
}

// ─── RAW ROW FETCHER ──────────────────────────────────────────────────────────

/**
 * Normalizes a request payload into a date filter object.
 * Supports single date, month, or from/to range.
 */
function _filterFromPayload(payload) {
  const { date, month, from, to } = payload || {};
  if (from || to) return { from: from || null, to: to || null };
  if (date)  return { date };
  if (month) return { month };
  return {};
}

function _filterLabel(filter) {
  if (filter.date)  return filter.date;
  if (filter.month) return filter.month;
  if (filter.from || filter.to) return `${filter.from || '…'} → ${filter.to || '…'}`;
  return '';
}

/**
 * Fetches rows from a sheet with the date filter applied in SQL (indexed),
 * falling back to in-JS filtering for clients without getSheetByDate.
 */
async function _getRows(sheetName, filter, sheets) {
  if (typeof sheets.getSheetByDate === 'function') {
    return sheets.getSheetByDate(sheetName, filter || {});
  }
  const rows = await sheets.getSheet(sheetName);
  const { date, month, from, to } = filter || {};
  if (!date && !month && !from && !to) return rows;
  const headers = await sheets.getSheetHeaders(sheetName);
  const colMap = buildColMap(headers);
  const dateIdx = findColIndex(colMap, 'Date');
  return rows.filter(row => {
    const d = dateIdx >= 0 ? _toIsoDate(row[dateIdx]) : '';
    if (date)  return d === date;
    if (month) return d.startsWith(month);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

// ─── LIMITS ───────────────────────────────────────────────────────────────────

// Limits change rarely; cache briefly so a dashboard load doesn't refetch them
// for every section. Invalidated on updateLimit.
let _limitsCache = null; // { map, ts }
const LIMITS_TTL_MS = 60 * 1000;

/**
 * Returns a map: limitId → { min, max, warnMin, warnMax, unit }
 */
async function getLimitsMap(sheets) {
  if (_limitsCache && Date.now() - _limitsCache.ts < LIMITS_TTL_MS) return _limitsCache.map;
  const rows = await sheets.getSheet(SH.LIMITS);
  const headers = await sheets.getSheetHeaders(SH.LIMITS);
  const colMap = buildColMap(headers);
  const idIdx      = findColIndex(colMap, 'ID');
  const minIdx     = findColIndex(colMap, 'Min');
  const maxIdx     = findColIndex(colMap, 'Max');
  const wminIdx    = findColIndex(colMap, 'Warn Min');
  const wmaxIdx    = findColIndex(colMap, 'Warn Max');
  const unitIdx    = findColIndex(colMap, 'Unit');
  const labelIdx   = findColIndex(colMap, 'Label');
  const prefixIdx  = findColIndex(colMap, 'Prefix');

  const map = {};
  rows.forEach(row => {
    const id = idIdx >= 0 ? String(row[idIdx] || '').trim() : '';
    if (!id) return;
    map[id] = {
      id,
      label:   labelIdx >= 0  ? String(row[labelIdx] || '').trim() : id,
      prefix:  prefixIdx >= 0 ? String(row[prefixIdx] || '').trim() : '',
      min:     minIdx >= 0    ? parseFloat(row[minIdx])  : null,
      max:     maxIdx >= 0    ? parseFloat(row[maxIdx])  : null,
      warnMin: wminIdx >= 0   ? parseFloat(row[wminIdx]) : null,
      warnMax: wmaxIdx >= 0   ? parseFloat(row[wmaxIdx]) : null,
      unit:    unitIdx >= 0   ? String(row[unitIdx] || '').trim() : '',
    };
  });
  _limitsCache = { map, ts: Date.now() };
  return map;
}

/**
 * Returns a map: paramId → target value
 */
async function getTargetsMap(month, sheets) {
  const rows = await sheets.getSheet(SH.TARGETS);
  const headers = await sheets.getSheetHeaders(SH.TARGETS);
  const colMap = buildColMap(headers);
  const monthIdx  = findColIndex(colMap, 'Month');
  const paramIdx  = findColIndex(colMap, 'Param ID');
  const targetIdx = findColIndex(colMap, 'Target');
  const map = {};
  rows.forEach(row => {
    const m = monthIdx >= 0 ? String(row[monthIdx] || '').trim() : '';
    if (month && m !== month) return;
    const param = paramIdx >= 0 ? String(row[paramIdx] || '').trim() : '';
    const target = targetIdx >= 0 ? parseFloat(row[targetIdx]) : NaN;
    if (param && !isNaN(target)) map[param] = target;
  });
  return map;
}

// ─── STATUS LOGIC ─────────────────────────────────────────────────────────────

function getStatus(value, limitId, limitsMap, targetsMap) {
  if (value === '' || value === null || value === undefined) return 'NO_DATA';
  const n = parseFloat(value);
  if (isNaN(n)) return 'NO_DATA';
  if (!limitId || !limitsMap[limitId]) return 'NORMAL';
  const lim = limitsMap[limitId];
  // Critical check
  if ((lim.min !== null && !isNaN(lim.min) && n < lim.min) ||
      (lim.max !== null && !isNaN(lim.max) && n > lim.max)) return 'CRITICAL';
  // Warning check
  if ((lim.warnMin !== null && !isNaN(lim.warnMin) && n < lim.warnMin) ||
      (lim.warnMax !== null && !isNaN(lim.warnMax) && n > lim.warnMax)) return 'WARNING';
  return 'NORMAL';
}

function getOverflowStatus(val) {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'yes') return 'CRITICAL';
  if (v === 'no' || v === '') return 'NORMAL';
  return 'NO_DATA';
}

function _worstStatus(statuses) {
  if (statuses.includes('CRITICAL')) return 'CRITICAL';
  if (statuses.includes('WARNING')) return 'WARNING';
  if (statuses.every(s => s === 'NO_DATA')) return 'NO_DATA';
  return 'NORMAL';
}

// ─── AUTO-CALC ────────────────────────────────────────────────────────────────

function _computeAutoCalc(sheetName, colMap, rowArray) {
  const get = (key) => {
    const idx = findColIndex(colMap, key);
    return idx >= 0 ? parseFloat(rowArray[idx]) : NaN;
  };
  const set = (key, val) => {
    const idx = findColIndex(colMap, key);
    if (idx >= 0) rowArray[idx] = val;
  };

  if (sheetName === SH.CRUSHING || sheetName === SH.MILLING) {
    const prod = get('Production');
    const hrs  = get(sheetName === SH.MILLING ? 'Running Hrs' : 'Running Hours');
    if (!isNaN(prod) && !isNaN(hrs) && hrs > 0) set('TPH', +(prod / hrs).toFixed(2));
  }
  if (sheetName === SH.GC) {
    const mass  = get('Mass (kg)');
    const grade = get('Au Grade (g/t)');
    if (!isNaN(mass) && !isNaN(grade)) set('Au Content (g)', +(mass * grade / 1000).toFixed(2));
  }
  if (sheetName === SH.GOLD) {
    const mass   = get('Dore Mass (g)');
    const purity = get('Purity (%)');
    if (!isNaN(mass) && !isNaN(purity)) set('Au Content (g)', +(mass * purity / 100).toFixed(2));
  }
  if (sheetName === SH.ILS) {
    const feed = get('Feed Au (ppm)');
    const raff = get('Raffinate Au (ppm)');
    if (!isNaN(feed) && !isNaN(raff) && feed > 0) set('Recovery (%)', +((feed - raff) / feed * 100).toFixed(1));
  }
  if (sheetName === SH.STOPPAGE) {
    const stopIdx  = findColIndex(colMap, 'Stop Time');
    const startIdx = findColIndex(colMap, 'Start Time');
    const hrsIdx   = findColIndex(colMap, 'Total Stoppage Hrs');
    if (stopIdx >= 0 && startIdx >= 0 && hrsIdx >= 0) {
      const stop  = String(rowArray[stopIdx]  || '');
      const start = String(rowArray[startIdx] || '');
      if (stop && start) {
        const [sh, sm] = stop.split(':').map(Number);
        const [eh, em] = start.split(':').map(Number);
        if (!isNaN(sh) && !isNaN(eh)) {
          let diff = (eh * 60 + (em||0)) - (sh * 60 + (sm||0));
          if (diff < 0) diff += 24 * 60;
          rowArray[hrsIdx] = +(diff / 60).toFixed(2);
        }
      }
    }
  }
}

/**
 * Recomputes auto-calc fields for DISPLAY when the stored value is missing —
 * e.g. rows saved before an auto-calc formula existed, imported without it,
 * or backfilled inconsistently. Never overwrites a value that's already
 * present; this is a safety net, not a source of truth (submitData is what
 * actually persists the calculated value).
 */
function _recomputeDisplayAutoCalc(sheetName, rowObj) {
  const num = (v) => { const n = parseFloat(v); return (v === '' || v === null || v === undefined || isNaN(n)) ? NaN : n; };
  const isBlank = (v) => v === '' || v === null || v === undefined || isNaN(parseFloat(v));

  if (sheetName === SH.CRUSHING || sheetName === SH.MILLING) {
    if (isBlank(rowObj['TPH'])) {
      const prod = num(rowObj['Production']);
      const hrs  = num(rowObj[sheetName === SH.MILLING ? 'Running Hrs' : 'Running Hours']);
      if (!isNaN(prod) && !isNaN(hrs) && hrs > 0) rowObj['TPH'] = +(prod / hrs).toFixed(2);
    }
  }
  if (sheetName === SH.GC && isBlank(rowObj['Au Content (g)'])) {
    const mass  = num(rowObj['Mass (kg)']);
    const grade = num(rowObj['Au Grade (g/t)']);
    if (!isNaN(mass) && !isNaN(grade)) rowObj['Au Content (g)'] = +(mass * grade / 1000).toFixed(2);
  }
  if (sheetName === SH.GOLD && isBlank(rowObj['Au Content (g)'])) {
    const mass    = num(rowObj['Dore Mass (g)']);
    const purity  = num(rowObj['Purity (%)']);
    if (!isNaN(mass) && !isNaN(purity)) rowObj['Au Content (g)'] = +(mass * purity / 100).toFixed(2);
  }
  if (sheetName === SH.ILS && isBlank(rowObj['Recovery (%)'])) {
    const feed = num(rowObj['Feed Au (ppm)']);
    const raff = num(rowObj['Raffinate Au (ppm)']);
    if (!isNaN(feed) && !isNaN(raff) && feed > 0) rowObj['Recovery (%)'] = +((feed - raff) / feed * 100).toFixed(1);
  }
}

// ─── PARAM STATUS ANNOTATION ──────────────────────────────────────────────────

function _annotateRow(rowObj, params, limitsMap, targetsMap) {
  params.forEach(p => {
    if (p.isOverflow) {
      rowObj[p.key + '__status'] = getOverflowStatus(rowObj[p.key]);
    } else if (p.limitId) {
      rowObj[p.key + '__status'] = getStatus(rowObj[p.key], p.limitId, limitsMap, targetsMap);
    } else if (!p.isText && !p.isTime && !p.autoCalc) {
      // numeric – just report NO_DATA or NORMAL (no limits defined)
      const v = rowObj[p.key];
      rowObj[p.key + '__status'] = (v !== '' && v !== null && v !== undefined && !isNaN(parseFloat(v))) ? 'NORMAL' : 'NO_DATA';
    }
  });
}

// ─── STOPPAGES ────────────────────────────────────────────────────────────────

async function _getStoppages(filter, sectionLabel, sheets) {
  const rows = await _getRows(SH.STOPPAGE, filter, sheets);
  const headers = await sheets.getSheetHeaders(SH.STOPPAGE);
  const colMap = buildColMap(headers);
  const dateIdx   = findColIndex(colMap, 'Date');
  const secIdx    = findColIndex(colMap, 'Section');
  const stopIdx   = findColIndex(colMap, 'Stop Time');
  const startIdx  = findColIndex(colMap, 'Start Time');
  const hrsIdx    = findColIndex(colMap, 'Total Stoppage Hrs');
  const deptIdx   = findColIndex(colMap, 'Department');
  const reasonIdx = findColIndex(colMap, 'Reason');

  let filtered = rows;
  if (sectionLabel) {
    filtered = rows.filter(r => {
      const sec = String(r[secIdx] || '').trim().toLowerCase();
      return sec === sectionLabel.toLowerCase() || sec.includes(sectionLabel.toLowerCase());
    });
  }

  return filtered.map(r => ({
    date:    _toIsoDate(r[dateIdx]),
    section: String(r[secIdx]   || '').trim(),
    stop:    String(r[stopIdx]  || '').trim(),
    start:   String(r[startIdx] || '').trim(),
    hrs:     parseFloat(r[hrsIdx]) || 0,
    dept:    String(r[deptIdx]  || '').trim(),
    reason:  String(r[reasonIdx]|| '').trim(),
  })).filter(s => s.date);
}

// ─── CHEMICAL STATUS FOR SECTION ─────────────────────────────────────────────

async function _getSectionChemStatus(sectionKey, filter, sheets) {
  const chems = SECTION_CHEMICALS[sectionKey] || [];
  if (!chems.length) return [];
  const rows = await _getRows(SH.CHEMICAL, filter, sheets);
  const headers = await sheets.getSheetHeaders(SH.CHEMICAL);
  const colMap = buildColMap(headers);

  const result = [];
  chems.forEach(chem => {
    const idx = findColIndex(colMap, chem);
    if (idx < 0) return;
    const total = rows.reduce((s, r) => s + (parseFloat(r[idx]) || 0), 0);
    result.push({ name: chem, total, hasData: rows.some(r => r[idx] !== '' && r[idx] !== null && r[idx] !== undefined) });
  });
  return result;
}

// ─── DAILY AGGREGATES (for monthly detail views) ─────────────────────────────

function _getDailyAggregates(rows, headers, numericKeys) {
  const colMap = buildColMap(headers);
  const byDay = {};
  rows.forEach(r => {
    const dateIdx = findColIndex(colMap, 'Date');
    const d = dateIdx >= 0 ? _toIsoDate(r[dateIdx]) : '';
    if (!d) return;
    if (!byDay[d]) { byDay[d] = { __date: d, __count: 0 }; numericKeys.forEach(k => { byDay[d][k] = 0; byDay[d][k + '_cnt'] = 0; }); }
    byDay[d].__count++;
    numericKeys.forEach(k => {
      const idx = findColIndex(colMap, k);
      const v = idx >= 0 ? parseFloat(r[idx]) : NaN;
      if (!isNaN(v)) { byDay[d][k] += v; byDay[d][k + '_cnt']++; }
    });
  });
  // convert sums to averages for grade-type params? – keep as sums here, caller decides
  return Object.values(byDay).sort((a, b) => a.__date.localeCompare(b.__date));
}

// ─── SECTION DATA ROW BUILDER ────────────────────────────────────────────────

async function _buildSectionRows(sheetName, params, filter, limitsMap, sheets) {
  const [rawRows, headers] = await Promise.all([
    _getRows(sheetName, filter, sheets),
    sheets.getSheetHeaders(sheetName),
  ]);
  const colMap = buildColMap(headers);
  const dateIdx  = findColIndex(colMap, 'Date');
  const timeIdx  = findColIndex(colMap, 'Time');
  const shiftIdx = findColIndex(colMap, 'Shift');

  const result = [];
  rawRows.forEach(r => {
    const rowObj = { __date: dateIdx >= 0 ? _toIsoDate(r[dateIdx]) : '' };
    if (timeIdx >= 0)  rowObj.__time  = String(r[timeIdx]  || '').trim();
    if (shiftIdx >= 0) rowObj.__shift = String(r[shiftIdx] || '').trim();

    params.forEach(p => {
      const idx = findColIndex(colMap, p.key);
      const raw = idx >= 0 ? r[idx] : '';
      if (p.isText || p.isTime || p.isSelect) {
        rowObj[p.key] = String(raw !== null && raw !== undefined ? raw : '').trim();
      } else {
        rowObj[p.key] = (raw !== '' && raw !== null && raw !== undefined) ? raw : '';
      }
    });
    _recomputeDisplayAutoCalc(sheetName, rowObj);
    _annotateRow(rowObj, params, limitsMap, {});
    result.push(rowObj);
  });
  return result;
}

// ─── DASHBOARD (INDEX DATA) ───────────────────────────────────────────────────

async function getIndexData(payload, sheets) {
  const sess = validateSession(payload.token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const filter = _filterFromPayload(payload);
  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));

  // Only top-level (non-grouped-child) sections get their own dashboard card;
  // grouped children (cyclone, thickener, slurry, carbon, screen) are folded
  // into their parent's card and reachable via sub-tabs on its detail page.
  const visible = Object.entries(SECTIONS).filter(
    ([key]) => !HIDDEN_FROM_DASHBOARD.has(key) && canSeeSection(sess.role, key)
  );

  // All sections load in parallel — one slow sheet no longer serializes the rest.
  const results = await Promise.all(visible.map(async ([key, secCfg]) => {
    const memberKeys = SECTION_GROUPS[key] || [key];
    try {
      const memberResults = await Promise.all(memberKeys.map(async (mKey) => {
        const mCfg = SECTIONS[mKey];
        const params = SHEET_PARAMS[mCfg.sheet] || [];
        const numParams = params.filter(p => !p.isText && !p.isTime && !p.isSelect && !p.autoCalc);
        const rows = await _buildSectionRows(mCfg.sheet, params, filter, limitsMap, sheets);

        const statuses = [];
        const flagged = [];
        rows.forEach(row => {
          numParams.forEach(p => {
            const s = row[p.key + '__status'];
            if (s) statuses.push(s);
            if (s === 'CRITICAL' || s === 'WARNING') {
              const already = flagged.find(f => f.key === p.key && f.sourceKey === mKey);
              if (!already) {
                flagged.push({ key: p.key, label: p.label, value: row[p.key], unit: p.unit, status: s, sourceKey: mKey, sourceLabel: mCfg.label });
              } else if (s === 'CRITICAL' && already.status !== 'CRITICAL') {
                already.status = 'CRITICAL';
                already.value = row[p.key];
              }
            }
          });
        });
        return { hasData: rows.length > 0, statuses, flagged, rows };
      }));

      const hasData = memberResults.some(m => m.hasData);
      const allStatuses = memberResults.flatMap(m => m.statuses);
      const flagged = memberResults.flatMap(m => m.flagged);

      return [key, {
        key, label: secCfg.label, color: secCfg.color,
        hasData,
        status:  _worstStatus(allStatuses.length ? allStatuses : ['NO_DATA']),
        flagged: flagged.sort((a, b) => (b.status === 'CRITICAL' ? 1 : 0) - (a.status === 'CRITICAL' ? 1 : 0)),
        _rows: memberResults[0].rows, // the group's own sheet — used for KPI sums below
      }];
    } catch (err) {
      console.error(`Dashboard section ${key} error:`, err.message);
      return [key, { key, label: secCfg.label, color: secCfg.color, hasData: false, status: 'NO_DATA', flagged: [], _rows: [] }];
    }
  }));

  // ── KPI strip: computed from the rows already fetched above ──
  const byKey = Object.fromEntries(results);
  const sumCol = (rows, col) => (rows || []).reduce((s, r) => s + (parseFloat(r[col]) || 0), 0);

  const kpis = [];
  if (byKey.crushing) kpis.push({ key: 'crushProd', label: 'Crushing Production', value: +sumCol(byKey.crushing._rows, 'Production').toFixed(1), unit: 't' });
  if (byKey.milling)  kpis.push({ key: 'millProd',  label: 'Milling Production',  value: +sumCol(byKey.milling._rows, 'Production').toFixed(1), unit: 't' });
  if (byKey.gold)     kpis.push({ key: 'goldAu',    label: 'Gold Produced',       value: +sumCol(byKey.gold._rows, 'Au Content (g)').toFixed(1), unit: 'g' });

  try {
    const stoppages = await _getStoppages(filter, null, sheets);
    kpis.push({ key: 'stopHrs', label: 'Stoppage Hours', value: +stoppages.reduce((s, x) => s + x.hrs, 0).toFixed(1), unit: 'hrs' });
  } catch (e) { /* stoppage sheet unavailable — omit tile */ }

  const critCount = results.filter(([, sec]) => sec.status === 'CRITICAL').length;
  const warnCount = results.filter(([, sec]) => sec.status === 'WARNING').length;
  kpis.push({ key: 'alerts', label: 'Sections Flagged', value: critCount + warnCount, unit: critCount > 0 ? `${critCount} critical` : '', status: critCount > 0 ? 'CRITICAL' : warnCount > 0 ? 'WARNING' : 'NORMAL' });

  const sectionResults = {};
  results.forEach(([key, sec]) => { delete sec._rows; sectionResults[key] = sec; });

  return {
    date: _filterLabel(filter), sections: sectionResults, kpis,
    groups: SECTION_GROUPS, groupTabLabels: GROUP_TAB_LABELS,
  };
}

// ─── SECTION DETAIL DATA ──────────────────────────────────────────────────────

async function getSectionData(payload, sheets) {
  const { token, section } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canSeeSection(sess.role, section)) return { error: 'Access denied.' };

  const secCfg = SECTIONS[section];
  if (!secCfg) return { error: 'Unknown section.' };

  const filter = _filterFromPayload(payload);
  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));
  const params = SHEET_PARAMS[secCfg.sheet] || [];

  const [rows, stoppages, chemicals] = await Promise.all([
    _buildSectionRows(secCfg.sheet, params, filter, limitsMap, sheets),
    _getStoppages(filter, secCfg.label, sheets).catch(() => []),
    _getSectionChemStatus(section, filter, sheets).catch(() => []),
  ]);
  const hasData = rows.length > 0;

  // Ship the limits referenced by this section's params so the client can
  // draw min/max bands on charts.
  const limits = {};
  params.forEach(p => {
    if (p.limitId && limitsMap[p.limitId]) limits[p.limitId] = limitsMap[p.limitId];
  });

  // For monthly/range view, compute per-day aggregate rows for charts
  const isAggregate = !!(filter.month || filter.from || filter.to);
  let dailyRows = [];
  if (isAggregate && rows.length > 0) {
    const byDate = {};
    rows.forEach(r => {
      const d = r.__date;
      if (!byDate[d]) byDate[d] = { __date: d, _rows: [] };
      byDate[d]._rows.push(r);
    });
    dailyRows = Object.values(byDate).map(g => {
      const agg = { __date: g.__date };
      params.forEach(p => {
        if (p.isText || p.isTime || p.isSelect) return;
        const vals = g._rows.map(r => parseFloat(r[p.key])).filter(v => !isNaN(v));
        agg[p.key] = vals.length ? +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : '';
        // Sum alongside the average — production-style totals need sums, not
        // averages, for cumulative-vs-target trajectories.
        agg[p.key + '__sum'] = vals.length ? +vals.reduce((a,b)=>a+b,0).toFixed(3) : '';
      });
      return agg;
    }).sort((a, b) => a.__date.localeCompare(b.__date));
  }

  // ── Monthly targets for this section's parameters (for target lines /
  // cumulative-vs-trajectory charts on the client) ──
  const targetMonth = filter.month || (filter.date || filter.to || filter.from || '').slice(0, 7);
  let targets = {};
  let targetDaysInMonth = null;
  if (targetMonth) {
    try {
      const targetsMap = await getTargetsMap(targetMonth, sheets);
      params.forEach(p => {
        const v = targetsMap[`${section}:${p.key}`];
        if (v !== undefined) targets[p.key] = v;
      });
      if (Object.keys(targets).length) {
        const [y, m] = targetMonth.split('-').map(Number);
        targetDaysInMonth = new Date(y, m, 0).getDate();
      }
    } catch (e) { /* targets sheet unavailable — omit */ }
  }

  const targetProgress = _computeTargetProgress(filter, rows, dailyRows, targets, targetMonth, targetDaysInMonth);

  return {
    section, label: secCfg.label, color: secCfg.color,
    date: _filterLabel(filter),
    isAggregate,
    hasData, rows, dailyRows, params, stoppages, chemicals, limits,
    targets, targetMonth, targetDaysInMonth, targetProgress,
  };
}

/**
 * Computes target-vs-actual progress for every targeted parameter.
 * - Date view: actual for that single day vs. the flat daily target
 *   (monthly target ÷ days in month).
 * - Month view: cumulative actual-so-far vs. expected-to-date (daily target
 *   × days elapsed), plus a run-rate projection for month-end and the
 *   current/required daily rates needed to hit the target.
 * Range view is skipped — "expected pace" isn't well-defined over an
 * arbitrary date range, so the client hides the block in that mode.
 *
 * Status is based on actual ÷ expected-to-date (or ÷ daily target for a
 * single day): >=100% is ON_TARGET (green), 80-99% is WARNING (yellow),
 * below 80% is BEHIND (red).
 */
function _computeTargetProgress(filter, rows, dailyRows, targets, targetMonth, targetDaysInMonth) {
  const progress = {};
  if (!targetMonth || !targetDaysInMonth || !Object.keys(targets).length) return progress;
  if (filter.from || filter.to) return progress; // range view: no well-defined pace

  const isDateMode = !!filter.date;

  Object.entries(targets).forEach(([paramKey, monthlyTarget]) => {
    if (!monthlyTarget || monthlyTarget <= 0) return;
    const dailyTarget = +(monthlyTarget / targetDaysInMonth).toFixed(4);

    if (isDateMode) {
      const actual = rows
        .filter(r => r.__date === filter.date)
        .reduce((s, r) => s + (parseFloat(r[paramKey]) || 0), 0);
      const variance = +(actual - dailyTarget).toFixed(2);
      progress[paramKey] = {
        mode: 'date',
        target: +dailyTarget.toFixed(2), actual: +actual.toFixed(2),
        variance,
        pctAchieved: dailyTarget ? +((actual / dailyTarget) * 100).toFixed(1) : 0,
        status: _progressStatus(dailyTarget ? actual / dailyTarget : 0),
      };
      return;
    }

    // Month mode
    const now = new Date();
    const [ty, tm] = targetMonth.split('-').map(Number);
    let daysElapsed;
    if (ty < now.getFullYear() || (ty === now.getFullYear() && tm < now.getMonth() + 1)) {
      daysElapsed = targetDaysInMonth; // a past month is fully elapsed
    } else if (ty === now.getFullYear() && tm === now.getMonth() + 1) {
      daysElapsed = now.getDate(); // current month — elapsed so far
    } else {
      daysElapsed = 0; // future month
    }

    const actual = (dailyRows || []).reduce((s, r) => s + (parseFloat(r[paramKey + '__sum']) || 0), 0);
    const expected = +(dailyTarget * daysElapsed).toFixed(2);
    const variance = +(actual - expected).toFixed(2);
    const projected = daysElapsed > 0 ? +((actual / daysElapsed) * targetDaysInMonth).toFixed(2) : 0;

    const currentRate = daysElapsed > 0 ? +(actual / daysElapsed).toFixed(2) : 0;
    const daysRemaining = targetDaysInMonth - daysElapsed;
    const requiredRate = daysRemaining > 0 ? +((monthlyTarget - actual) / daysRemaining).toFixed(2) : null;

    progress[paramKey] = {
      mode: 'month',
      monthlyTarget, dailyTarget: +dailyTarget.toFixed(2),
      actual: +actual.toFixed(2), expected, variance,
      pctAchieved: +((actual / monthlyTarget) * 100).toFixed(1),
      projected, daysElapsed, daysInMonth: targetDaysInMonth,
      currentRate, requiredRate,
      status: daysElapsed === 0 ? 'NO_DATA' : _progressStatus(expected ? actual / expected : 0),
    };
  });

  return progress;
}

// ratio = actual / expected-to-date (or actual / daily target for a single day)
function _progressStatus(ratio) {
  if (ratio >= 1) return 'ON_TARGET';
  if (ratio >= 0.8) return 'WARNING';
  return 'BEHIND';
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────

/**
 * Returns every critical/warning reading across all visible sections for the
 * requested period: [{ date, time, section, sectionKey, param, value, unit, status }]
 */
async function getAlerts(payload, sheets) {
  const sess = validateSession(payload.token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const filter = _filterFromPayload(payload);
  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));
  const visible = Object.entries(SECTIONS).filter(([key]) => canSeeSection(sess.role, key));

  const perSection = await Promise.all(visible.map(async ([key, secCfg]) => {
    try {
      const params = SHEET_PARAMS[secCfg.sheet] || [];
      const flaggable = params.filter(p => p.limitId || p.isOverflow);
      if (!flaggable.length) return [];
      const rows = await _buildSectionRows(secCfg.sheet, params, filter, limitsMap, sheets);
      const alerts = [];
      rows.forEach(row => {
        flaggable.forEach(p => {
          const s = row[p.key + '__status'];
          if (s !== 'CRITICAL' && s !== 'WARNING') return;
          const lim = p.limitId ? limitsMap[p.limitId] : null;
          alerts.push({
            date: row.__date, time: row.__time || row.__shift || '',
            section: secCfg.label, sectionKey: key,
            param: p.key, value: row[p.key], unit: p.unit || '',
            status: s,
            limit: lim ? { min: lim.min, max: lim.max, warnMin: lim.warnMin, warnMax: lim.warnMax } : null,
          });
        });
      });
      return alerts;
    } catch (err) {
      console.error(`Alerts section ${key} error:`, err.message);
      return [];
    }
  }));

  const alerts = perSection.flat().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'CRITICAL' ? -1 : 1;
    return String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time));
  });

  return {
    date: _filterLabel(filter),
    total: alerts.length,
    critical: alerts.filter(a => a.status === 'CRITICAL').length,
    warning: alerts.filter(a => a.status === 'WARNING').length,
    alerts,
  };
}

// ─── ENTRY FORM CONFIG ────────────────────────────────────────────────────────

async function getEntryFormConfig(payload, sheets) {
  const { token, sheet } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canWrite(sess.role, sheet)) return { error: 'No write access to this sheet.' };

  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));
  const params = (SHEET_PARAMS[sheet] || []).filter(p => p.key !== 'Date' && p.key !== 'Time' && p.key !== 'Shift');

  const enriched = params.map(p => {
    const ep = { ...p };
    if (p.limitId && limitsMap[p.limitId]) {
      const lim = limitsMap[p.limitId];
      const parts = [];
      if (lim.min !== null && !isNaN(lim.min)) parts.push(`Min: ${lim.min}`);
      if (lim.max !== null && !isNaN(lim.max)) parts.push(`Max: ${lim.max}`);
      ep.limitDisplay = parts.join(', ');
    }
    return ep;
  });

  return { sheet, params: enriched };
}

// ─── SUBMIT DATA ──────────────────────────────────────────────────────────────

async function submitData(payload, sheets) {
  const { token, sheet, date, shift, notes, values } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canWrite(sess.role, sheet)) return { error: 'No write access to this sheet.' };
  if (!date) return { error: 'Date is required.' };

  const headers = await sheets.getSheetHeaders(sheet);
  const colMap = buildColMap(headers);

  // Build row array aligned to headers
  const rowArray = new Array(headers.length).fill('');

  // Set date
  const dateIdx = findColIndex(colMap, 'Date');
  if (dateIdx >= 0) rowArray[dateIdx] = date;

  // Set time/shift
  if (shift) {
    const timeIdx  = findColIndex(colMap, 'Time');
    const shiftIdx = findColIndex(colMap, 'Shift');
    if (timeIdx >= 0)  rowArray[timeIdx]  = shift;
    if (shiftIdx >= 0) rowArray[shiftIdx] = shift;
  }

  // Set values from payload
  if (values && typeof values === 'object') {
    Object.entries(values).forEach(([key, val]) => {
      const idx = findColIndex(colMap, key);
      if (idx >= 0) rowArray[idx] = val;
    });
  }

  // Set notes
  if (notes) {
    const notesIdx = findColIndex(colMap, 'Notes');
    if (notesIdx >= 0) rowArray[notesIdx] = notes;
  }

  // Set submitted by / timestamp
  const byIdx = findColIndex(colMap, 'Submitted By');
  const tsIdx = findColIndex(colMap, 'Timestamp');
  if (byIdx >= 0) rowArray[byIdx] = sess.name || sess.username;
  if (tsIdx >= 0) rowArray[tsIdx] = new Date().toISOString();

  // Auto-calc
  _computeAutoCalc(sheet, colMap, rowArray);
  if (sheet === SH.GOLD) await _computeGoldCumulative(sheets, colMap, rowArray);

  await sheets.appendRow(sheet, rowArray);
  return { success: true };
}

/**
 * Gold's Cumulative (g) is a running total across all entries, so unlike
 * the other auto-calc fields it needs the sheet's existing history, not
 * just the current row — computed separately since _computeAutoCalc is
 * synchronous. Assumes entries are submitted in chronological order.
 */
async function _computeGoldCumulative(sheets, colMap, rowArray) {
  const auIdx  = findColIndex(colMap, 'Au Content (g)');
  const cumIdx = findColIndex(colMap, 'Cumulative (g)');
  if (auIdx < 0 || cumIdx < 0) return;

  const thisAu = parseFloat(rowArray[auIdx]) || 0;
  const existingRows = await sheets.getSheet(SH.GOLD);
  const priorTotal = existingRows.reduce((sum, r) => sum + (parseFloat(r[auIdx]) || 0), 0);
  rowArray[cumIdx] = +(priorTotal + thisAu).toFixed(2);
}

// ─── PARAMETER CATALOG ────────────────────────────────────────────────────────
// The app's config already defines every section and parameter, so admin
// screens (targets, limits) offer dropdowns instead of hand-typed IDs.

/**
 * Returns the sections and their target-able parameters for dropdown UIs:
 * { sections: [{ key, label, params: [{ key, unit }] }] }
 */
function getParamCatalog(payload) {
  const sess = validateSession(payload.token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const sections = Object.entries(SECTIONS).map(([key, secCfg]) => {
    const params = (SHEET_PARAMS[secCfg.sheet] || [])
      .filter(p => !p.isText && !p.isTime && !p.isSelect && !p.isOverflow)
      .map(p => ({ key: p.key, unit: p.unit || '' }));
    return { key, label: secCfg.label, params };
  }).filter(s => s.params.length);

  return { sections };
}

/**
 * Returns every parameter that supports limits, joined with current limit
 * values: [{ limitId, section, sectionKey, param, unit, min, max, warnMin, warnMax }]
 * Legacy limit rows whose ID isn't referenced by any parameter are included
 * under section 'Other' so nothing becomes invisible.
 */
async function getLimitCatalog(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));

  const catalog = [];
  const seen = new Set();
  Object.entries(SECTIONS).forEach(([sectionKey, secCfg]) => {
    (SHEET_PARAMS[secCfg.sheet] || []).forEach(p => {
      if (!p.limitId || seen.has(p.limitId)) return;
      seen.add(p.limitId);
      const lim = limitsMap[p.limitId] || {};
      catalog.push({
        limitId: p.limitId,
        section: secCfg.label, sectionKey,
        param: p.key, unit: p.unit || lim.unit || '',
        min: lim.min ?? null, max: lim.max ?? null,
        warnMin: lim.warnMin ?? null, warnMax: lim.warnMax ?? null,
        exists: !!limitsMap[p.limitId],
      });
    });
  });

  // Legacy/custom limit rows not referenced by any configured parameter
  Object.values(limitsMap).forEach(lim => {
    if (seen.has(lim.id)) return;
    catalog.push({
      limitId: lim.id, section: 'Other', sectionKey: 'other',
      param: lim.label || lim.id, unit: lim.unit || '',
      min: lim.min ?? null, max: lim.max ?? null,
      warnMin: lim.warnMin ?? null, warnMax: lim.warnMax ?? null,
      exists: true,
    });
  });

  return { limits: catalog };
}

/**
 * Creates or updates a limit by its ID — no row numbers involved.
 * payload: { limitId, min, max, warnMin, warnMax } (empty string/null clears)
 */
async function upsertLimit(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const { limitId, min, max, warnMin, warnMax } = payload;
  if (!limitId) return { error: 'limitId is required.' };

  // Resolve label/prefix/unit from config when this limit backs a known param
  let label = limitId, unit = payload.unit || '';
  for (const secCfg of Object.values(SECTIONS)) {
    const p = (SHEET_PARAMS[secCfg.sheet] || []).find(x => x.limitId === limitId);
    if (p) { label = `${secCfg.label} — ${p.key}`; unit = unit || p.unit || ''; break; }
  }
  const prefix = String(limitId).split('_')[0];
  const num = v => (v === '' || v === null || v === undefined || isNaN(parseFloat(v))) ? '' : parseFloat(v);

  const headers = await sheets.getSheetHeaders(SH.LIMITS);
  const colMap = buildColMap(headers);
  const row = new Array(headers.length).fill('');
  const set = (key, val) => { const i = findColIndex(colMap, key); if (i >= 0) row[i] = val; };
  set('ID', limitId);
  set('Label', label);
  set('Prefix', prefix);
  set('Min', num(min));
  set('Max', num(max));
  set('Warn Min', num(warnMin));
  set('Warn Max', num(warnMax));
  set('Unit', unit);

  const rows = await sheets.getSheet(SH.LIMITS);
  const idIdx = findColIndex(colMap, 'ID');
  const existingIdx = rows.findIndex(r => String(r[idIdx] || '').trim() === limitId);

  if (existingIdx >= 0) {
    await sheets.updateRow(SH.LIMITS, DB_START + existingIdx, row);
  } else {
    await sheets.appendRow(SH.LIMITS, row);
  }
  _limitsCache = null;
  return { success: true };
}

// ─── LIMITS CRUD ──────────────────────────────────────────────────────────────

async function getAllLimits(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const rows = await sheets.getSheet(SH.LIMITS);
  const headers = await sheets.getSheetHeaders(SH.LIMITS);
  const colMap = buildColMap(headers);

  return rows.map((row, i) => {
    const obj = { rowNum: DB_START + i };
    headers.forEach((h, j) => { if (h) obj[String(h).trim()] = row[j] !== undefined ? row[j] : ''; });
    return obj;
  }).filter(r => r['ID']);
}

async function updateLimit(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const { rowNum, row } = payload;
  if (!rowNum || !row) return { error: 'Missing rowNum or row data.' };
  await sheets.updateRow(SH.LIMITS, rowNum, row);
  _limitsCache = null;
  return { success: true };
}

// ─── TARGETS CRUD ─────────────────────────────────────────────────────────────

async function getAllTargets(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canManageTargets(sess.role)) return { error: 'Access denied.' };

  const rows = await sheets.getSheet(SH.TARGETS);
  const headers = await sheets.getSheetHeaders(SH.TARGETS);
  const colMap = buildColMap(headers);
  const monthIdx  = findColIndex(colMap, 'Month');
  const paramIdx  = findColIndex(colMap, 'Param ID');
  const pNameIdx  = findColIndex(colMap, 'Param');
  const unitIdx   = findColIndex(colMap, 'Unit');
  const targetIdx = findColIndex(colMap, 'Target');
  const notesIdx  = findColIndex(colMap, 'Notes');
  const byIdx     = findColIndex(colMap, 'Set By');

  return rows.map((row, i) => ({
    rowNum:  DB_START + i,
    month:   monthIdx >= 0  ? String(row[monthIdx] || '').trim()  : '',
    paramId: paramIdx >= 0  ? String(row[paramIdx] || '').trim()  : '',
    param:   pNameIdx >= 0  ? String(row[pNameIdx] || '').trim()  : '',
    unit:    unitIdx >= 0   ? String(row[unitIdx] || '').trim()   : '',
    target:  targetIdx >= 0 ? parseFloat(row[targetIdx]) || 0     : 0,
    notes:   notesIdx >= 0  ? String(row[notesIdx] || '').trim()  : '',
    setBy:   byIdx >= 0     ? String(row[byIdx] || '').trim()     : '',
  })).filter(t => t.month && t.paramId);
}

async function saveTarget(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canManageTargets(sess.role)) return { error: 'Access denied.' };

  let { month, paramId, param, unit, target, notes, rowNum, section, paramKey } = payload;
  if (!month) return { error: 'Month is required.' };

  // Catalog mode: derive id/label/unit from the configured section + parameter
  if (section && paramKey) {
    const secCfg = SECTIONS[section];
    if (!secCfg) return { error: 'Unknown section.' };
    const p = (SHEET_PARAMS[secCfg.sheet] || []).find(x => x.key === paramKey);
    if (!p) return { error: 'Unknown parameter for this section.' };
    paramId = `${section}:${p.key}`;
    param   = `${secCfg.label} — ${p.key}`;
    unit    = unit || p.unit || '';
  }
  if (!paramId) return { error: 'Select a parameter (or enter a custom Param ID).' };

  const headers = await sheets.getSheetHeaders(SH.TARGETS);
  const colMap = buildColMap(headers);
  const row = new Array(headers.length).fill('');
  const set = (key, val) => { const i = findColIndex(colMap, key); if (i >= 0) row[i] = val; };
  set('Month', month);
  set('Param ID', paramId);
  set('Param', param || paramId);
  set('Unit', unit || '');
  set('Target', target || 0);
  set('Notes', notes || '');
  set('Set By', sess.name || sess.username);
  set('Updated', new Date().toISOString());

  // Upsert: one target per (month, param) — no duplicate rows from re-saving
  if (!rowNum) {
    const rows = await sheets.getSheet(SH.TARGETS);
    const monthIdx = findColIndex(colMap, 'Month');
    const idIdx    = findColIndex(colMap, 'Param ID');
    const existingIdx = rows.findIndex(r =>
      String(r[monthIdx] || '').trim() === month && String(r[idIdx] || '').trim() === paramId);
    if (existingIdx >= 0) rowNum = DB_START + existingIdx;
  }

  if (rowNum) {
    await sheets.updateRow(SH.TARGETS, rowNum, row);
  } else {
    await sheets.appendRow(SH.TARGETS, row);
  }
  return { success: true };
}

// ─── CHEMICAL INVENTORY ───────────────────────────────────────────────────────

async function getChemicalInventory(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const rows = await sheets.getSheet(SH.CHEM_INV);
  const headers = await sheets.getSheetHeaders(SH.CHEM_INV);

  return rows.map((row, i) => {
    const obj = { rowNum: DB_START + i };
    headers.forEach((h, j) => { if (h) obj[String(h).trim()] = row[j] !== undefined ? row[j] : ''; });
    return obj;
  }).filter(r => r['Chemical'] || r['Name']);
}

async function updateChemInventory(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor' && !ROLE_CONFIG[sess.role]?.canChemAdmin) {
    return { error: 'Access denied.' };
  }

  const { rowNum, row } = payload;
  if (!rowNum || !row) return { error: 'Missing rowNum or row data.' };
  await sheets.updateRow(SH.CHEM_INV, rowNum, row);
  return { success: true };
}

// ─── MONTHLY REPORT ───────────────────────────────────────────────────────────

async function getMonthlyReport(payload, sheets) {
  const { token, month } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canManageTargets(sess.role)) return { error: 'Access denied.' };
  if (!month) return { error: 'Month is required.' };

  const result = { month };
  const filter = { month };

  // All four report blocks fetch independently — run them in parallel.
  const [crushBlock, millBlock, chemBlock, stopBlock] = await Promise.allSettled([
    Promise.all([_getRows(SH.CRUSHING, filter, sheets), sheets.getSheetHeaders(SH.CRUSHING)]),
    Promise.all([_getRows(SH.MILLING,  filter, sheets), sheets.getSheetHeaders(SH.MILLING)]),
    Promise.all([_getRows(SH.CHEMICAL, filter, sheets), sheets.getSheetHeaders(SH.CHEMICAL)]),
    Promise.all([_getRows(SH.STOPPAGE, filter, sheets), sheets.getSheetHeaders(SH.STOPPAGE)]),
  ]);

  // Crushing
  try {
    if (crushBlock.status !== 'fulfilled') throw new Error(crushBlock.reason);
    const [crushRows, crushHeaders] = crushBlock.value;
    const crushColMap = buildColMap(crushHeaders);
    const runHrsIdx = findColIndex(crushColMap, 'Running Hours');
    const prodIdx   = findColIndex(crushColMap, 'Production');
    const runHours  = crushRows.reduce((s, r) => s + (parseFloat(r[runHrsIdx]) || 0), 0);
    const production = crushRows.reduce((s, r) => s + (parseFloat(r[prodIdx]) || 0), 0);
    result.crushing = { runHours, production, avgTph: runHours > 0 ? +(production / runHours).toFixed(2) : 0 };
  } catch (e) { result.crushing = null; }

  // Milling
  try {
    if (millBlock.status !== 'fulfilled') throw new Error(millBlock.reason);
    const [millRows, millHeaders] = millBlock.value;
    const millColMap = buildColMap(millHeaders);
    const runHrsIdx  = findColIndex(millColMap, 'Running Hrs');
    const prodIdx    = findColIndex(millColMap, 'Production');
    const fgIdx      = findColIndex(millColMap, 'Feed Grade');
    const runHours   = millRows.reduce((s, r) => s + (parseFloat(r[runHrsIdx]) || 0), 0);
    const production = millRows.reduce((s, r) => s + (parseFloat(r[prodIdx]) || 0), 0);
    const fgVals     = millRows.map(r => parseFloat(r[fgIdx])).filter(v => !isNaN(v));
    result.milling = {
      runHours, production,
      feedGrade: fgVals.length ? +(fgVals.reduce((a,b)=>a+b,0)/fgVals.length).toFixed(2) : 0,
    };
  } catch (e) { result.milling = null; }

  // Chemicals
  try {
    if (chemBlock.status !== 'fulfilled') throw new Error(chemBlock.reason);
    const [chemRows, chemHeaders] = chemBlock.value;
    const chemColMap = buildColMap(chemHeaders);
    const chemNames = [
      'Fresh Carbon','Hydrated Lime','Sodium Hypochlorite','Calcium Hypochlorite',
      'Flocculant','Coagulant','Cyanide Leaching','Cyanide ILS','Cyanide Elution',
      'Caustic Soda','Zinc','Lead Acetate','HCl','H2O2',
    ];
    const units = { 'Sodium Hypochlorite':'L','HCl':'L','H2O2':'L' };
    result.chemicals = chemNames.map(name => {
      const idx = findColIndex(chemColMap, name);
      const total = idx >= 0 ? chemRows.reduce((s, r) => s + (parseFloat(r[idx]) || 0), 0) : 0;
      return { name, unit: units[name] || 'kg', total };
    });
  } catch (e) { result.chemicals = []; }

  // Stoppages
  try {
    if (stopBlock.status !== 'fulfilled') throw new Error(stopBlock.reason);
    const [stopRows, stopHeaders] = stopBlock.value;
    const stopColMap = buildColMap(stopHeaders);
    const secIdx    = findColIndex(stopColMap, 'Section');
    const deptIdx   = findColIndex(stopColMap, 'Department');
    const hrsIdx    = findColIndex(stopColMap, 'Total Stoppage Hrs');
    const reasonIdx = findColIndex(stopColMap, 'Reason');

    const bySection = {}, byDept = {}, byReason = {};
    stopRows.forEach(r => {
      const hrs    = parseFloat(r[hrsIdx]) || 0;
      const sec    = String(r[secIdx]    || '').trim();
      const dept   = String(r[deptIdx]   || '').trim();
      const reason = String(r[reasonIdx] || '').trim();
      if (sec)    bySection[sec]  = (bySection[sec]  || 0) + hrs;
      if (dept)   byDept[dept]    = (byDept[dept]    || 0) + hrs;
      if (reason) byReason[reason]= (byReason[reason]|| 0) + hrs;
    });

    result.stoppages = {
      total:      Object.values(bySection).reduce((a,b)=>a+b,0),
      bySection:  Object.entries(bySection).map(([section,hrs])=>({section,hrs})).sort((a,b)=>b.hrs-a.hrs),
      byDept:     Object.entries(byDept).map(([dept,hrs])=>({dept,hrs})).sort((a,b)=>b.hrs-a.hrs),
      topReasons: Object.entries(byReason).map(([reason,hrs])=>({reason,hrs})).sort((a,b)=>b.hrs-a.hrs).slice(0,10),
    };
  } catch (e) { result.stoppages = null; }

  return result;
}

module.exports = {
  getLimitsMap, getTargetsMap, getStatus, getOverflowStatus,
  getIndexData, getSectionData, getEntryFormConfig, submitData,
  getMonthlyReport, getAlerts,
  getAllLimits, updateLimit,
  getParamCatalog, getLimitCatalog, upsertLimit,
  getAllTargets, saveTarget,
  getChemicalInventory, updateChemInventory,
  buildColMap, findColIndex,
};
