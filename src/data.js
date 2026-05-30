'use strict';

const {
  DB_START, SH, LT_TANKS, DT_TANKS, CARBON_TANKS,
  SECTIONS, SHEET_PARAMS, SECTION_CHEMICALS,
  canWrite, canSeeSection, canManageTargets,
} = require('./config');
const { validateSession } = require('./auth');

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

function _toIsoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const m2 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    return v;
  }
  if (typeof v === 'number') {
    const msPerDay = 86400000;
    const epoch = new Date(1899, 11, 30);
    const date = new Date(epoch.getTime() + v * msPerDay);
    return date.toISOString().slice(0, 10);
  }
  return String(v);
}

async function _getRows(sheetName, date, month, sheets) {
  const rows = await sheets.getSheet(sheetName);
  const headers = await sheets.getSheetHeaders(sheetName);
  const colMap = buildColMap(headers);
  const dateIdx = findColIndex(colMap, 'Date');
  if (!date && !month) return rows;
  return rows.filter(row => {
    const d = dateIdx >= 0 ? _toIsoDate(row[dateIdx]) : '';
    if (date) return d === date;
    if (month) return d.startsWith(month);
    return true;
  });
}

async function getLimitsMap(sheets) {
  const rows = await sheets.getSheet(SH.LIMITS);
  const headers = await sheets.getSheetHeaders(SH.LIMITS);
  const colMap = buildColMap(headers);
  const idIdx     = findColIndex(colMap, 'ID');
  const minIdx    = findColIndex(colMap, 'Min');
  const maxIdx    = findColIndex(colMap, 'Max');
  const wminIdx   = findColIndex(colMap, 'Warn Min');
  const wmaxIdx   = findColIndex(colMap, 'Warn Max');
  const unitIdx   = findColIndex(colMap, 'Unit');
  const labelIdx  = findColIndex(colMap, 'Label');
  const prefixIdx = findColIndex(colMap, 'Prefix');

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
  return map;
}

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

function getStatus(value, limitId, limitsMap) {
  if (value === '' || value === null || value === undefined) return 'NO_DATA';
  const n = parseFloat(value);
  if (isNaN(n)) return 'NO_DATA';
  if (!limitId || !limitsMap[limitId]) return 'NORMAL';
  const lim = limitsMap[limitId];
  if ((lim.min !== null && !isNaN(lim.min) && n < lim.min) ||
      (lim.max !== null && !isNaN(lim.max) && n > lim.max)) return 'CRITICAL';
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

function _annotateRow(rowObj, params, limitsMap) {
  params.forEach(p => {
    if (p.isOverflow) {
      rowObj[p.key + '__status'] = getOverflowStatus(rowObj[p.key]);
    } else if (p.limitId) {
      rowObj[p.key + '__status'] = getStatus(rowObj[p.key], p.limitId, limitsMap);
    } else if (!p.isText && !p.isTime && !p.autoCalc) {
      const v = rowObj[p.key];
      rowObj[p.key + '__status'] = (v !== '' && v !== null && v !== undefined && !isNaN(parseFloat(v))) ? 'NORMAL' : 'NO_DATA';
    }
  });
}

async function _getStoppages(date, month, sectionLabel, sheets) {
  const rows = await _getRows(SH.STOPPAGE, date, month, sheets);
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

async function _getSectionChemStatus(sectionKey, date, month, sheets) {
  const chems = SECTION_CHEMICALS[sectionKey] || [];
  if (!chems.length) return [];
  const rows = await _getRows(SH.CHEMICAL, date, month, sheets);
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

async function _buildSectionRows(sheetName, params, date, month, limitsMap, sheets) {
  const rawRows = await _getRows(sheetName, date, month, sheets);
  const headers = await sheets.getSheetHeaders(sheetName);
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
    _annotateRow(rowObj, params, limitsMap);
    result.push(rowObj);
  });
  return result;
}

async function getIndexData(payload, sheets) {
  const { token, date, month } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));
  const filterDate  = date  || null;
  const filterMonth = month || null;
  const displayDate = filterDate || filterMonth || '';

  const sectionResults = {};

  for (const [key, secCfg] of Object.entries(SECTIONS)) {
    if (!canSeeSection(sess.role, key)) continue;
    try {
      const params = SHEET_PARAMS[secCfg.sheet] || [];
      const numParams = params.filter(p => !p.isText && !p.isTime && !p.isSelect && !p.autoCalc);
      const rows = await _buildSectionRows(secCfg.sheet, params, filterDate, filterMonth, limitsMap, sheets);

      const hasData = rows.length > 0;
      const allStatuses = [];
      const flagged = [];

      rows.forEach(row => {
        numParams.forEach(p => {
          const s = row[p.key + '__status'];
          if (s) allStatuses.push(s);
          if (s === 'CRITICAL' || s === 'WARNING') {
            const already = flagged.find(f => f.key === p.key);
            if (!already) {
              flagged.push({ key: p.key, label: p.label, value: row[p.key], unit: p.unit, status: s });
            } else if (s === 'CRITICAL' && already.status !== 'CRITICAL') {
              already.status = 'CRITICAL';
              already.value = row[p.key];
            }
          }
        });
      });

      sectionResults[key] = {
        key, label: secCfg.label, color: secCfg.color, hasData,
        status: _worstStatus(allStatuses.length ? allStatuses : ['NO_DATA']),
        flagged: flagged.sort((a, b) => (b.status === 'CRITICAL' ? 1 : 0) - (a.status === 'CRITICAL' ? 1 : 0)),
      };
    } catch (err) {
      console.error(`Dashboard section ${key} error:`, err.message);
      sectionResults[key] = { key, label: secCfg.label, color: secCfg.color, hasData: false, status: 'NO_DATA', flagged: [] };
    }
  }

  return { date: displayDate, sections: sectionResults };
}

async function getSectionData(payload, sheets) {
  const { token, section, date, month } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canSeeSection(sess.role, section)) return { error: 'Access denied.' };

  const secCfg = SECTIONS[section];
  if (!secCfg) return { error: 'Unknown section.' };

  const limitsMap = await getLimitsMap(sheets).catch(() => ({}));
  const filterDate  = date  || null;
  const filterMonth = month || null;
  const params = SHEET_PARAMS[secCfg.sheet] || [];

  const rows = await _buildSectionRows(secCfg.sheet, params, filterDate, filterMonth, limitsMap, sheets);
  const hasData = rows.length > 0;

  const stoppages = await _getStoppages(filterDate, filterMonth, secCfg.label, sheets).catch(() => []);
  const chemicals = await _getSectionChemStatus(section, filterDate, filterMonth, sheets).catch(() => []);

  let dailyRows = [];
  if (filterMonth && rows.length > 0) {
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
      });
      return agg;
    }).sort((a, b) => a.__date.localeCompare(b.__date));
  }

  return {
    section, label: secCfg.label, color: secCfg.color,
    date: filterDate || filterMonth,
    hasData, rows, dailyRows, params, stoppages, chemicals,
  };
}

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

async function submitData(payload, sheets) {
  const { token, sheet, date, shift, notes, values } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canWrite(sess.role, sheet)) return { error: 'No write access to this sheet.' };
  if (!date) return { error: 'Date is required.' };

  const headers = await sheets.getSheetHeaders(sheet);
  const colMap = buildColMap(headers);
  const rowArray = new Array(headers.length).fill('');

  const dateIdx = findColIndex(colMap, 'Date');
  if (dateIdx >= 0) rowArray[dateIdx] = date;

  if (shift) {
    const timeIdx  = findColIndex(colMap, 'Time');
    const shiftIdx = findColIndex(colMap, 'Shift');
    if (timeIdx >= 0)  rowArray[timeIdx]  = shift;
    if (shiftIdx >= 0) rowArray[shiftIdx] = shift;
  }

  if (values && typeof values === 'object') {
    Object.entries(values).forEach(([key, val]) => {
      const idx = findColIndex(colMap, key);
      if (idx >= 0) rowArray[idx] = val;
    });
  }

  if (notes) {
    const notesIdx = findColIndex(colMap, 'Notes');
    if (notesIdx >= 0) rowArray[notesIdx] = notes;
  }

  const byIdx = findColIndex(colMap, 'Submitted By');
  const tsIdx = findColIndex(colMap, 'Timestamp');
  if (byIdx >= 0) rowArray[byIdx] = sess.name || sess.username;
  if (tsIdx >= 0) rowArray[tsIdx] = new Date().toISOString();

  _computeAutoCalc(sheet, colMap, rowArray);
  await sheets.appendRow(sheet, rowArray);
  return { success: true };
}

async function getAllLimits(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const rows = await sheets.getSheet(SH.LIMITS);
  const headers = await sheets.getSheetHeaders(SH.LIMITS);

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
  return { success: true };
}

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

  const { month, paramId, param, unit, target, notes, rowNum } = payload;
  if (!month || !paramId) return { error: 'Month and Param ID required.' };

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

  if (rowNum) {
    await sheets.updateRow(SH.TARGETS, rowNum, row);
  } else {
    await sheets.appendRow(SH.TARGETS, row);
  }
  return { success: true };
}

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

  const { rowNum, row } = payload;
  if (!rowNum || !row) return { error: 'Missing rowNum or row data.' };
  await sheets.updateRow(SH.CHEM_INV, rowNum, row);
  return { success: true };
}

async function getMonthlyReport(payload, sheets) {
  const { token, month } = payload;
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (!canManageTargets(sess.role)) return { error: 'Access denied.' };
  if (!month) return { error: 'Month is required.' };

  const result = { month };

  try {
    const crushRows = await _getRows(SH.CRUSHING, null, month, sheets);
    const crushHeaders = await sheets.getSheetHeaders(SH.CRUSHING);
    const crushColMap = buildColMap(crushHeaders);
    const runHrsIdx = findColIndex(crushColMap, 'Running Hours');
    const prodIdx   = findColIndex(crushColMap, 'Production');
    const runHours  = crushRows.reduce((s, r) => s + (parseFloat(r[runHrsIdx]) || 0), 0);
    const production = crushRows.reduce((s, r) => s + (parseFloat(r[prodIdx]) || 0), 0);
    result.crushing = { runHours, production, avgTph: runHours > 0 ? +(production / runHours).toFixed(2) : 0 };
  } catch (e) { result.crushing = null; }

  try {
    const millRows = await _getRows(SH.MILLING, null, month, sheets);
    const millHeaders = await sheets.getSheetHeaders(SH.MILLING);
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

  try {
    const chemRows = await _getRows(SH.CHEMICAL, null, month, sheets);
    const chemHeaders = await sheets.getSheetHeaders(SH.CHEMICAL);
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

  try {
    const stopRows = await _getRows(SH.STOPPAGE, null, month, sheets);
    const stopHeaders = await sheets.getSheetHeaders(SH.STOPPAGE);
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
      if (sec)    bySection[sec]   = (bySection[sec]   || 0) + hrs;
      if (dept)   byDept[dept]     = (byDept[dept]     || 0) + hrs;
      if (reason) byReason[reason] = (byReason[reason] || 0) + hrs;
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
  getMonthlyReport,
  getAllLimits, updateLimit,
  getAllTargets, saveTarget,
  getChemicalInventory, updateChemInventory,
  buildColMap, findColIndex,
};
