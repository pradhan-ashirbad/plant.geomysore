/* ═══════════════════════════════════════════════════════════════════
   Plant Monitoring System — Client Application
   Jonnagiri Gold Project · Geomysore
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
const STATE = {
  token: null, role: null, name: null, roleLabel: null,
  filterMode: 'date', filterDate: null, filterMonth: null,
  detailMode: 'date', currentSec: null,
  charts: {},
  adminPanel: 'users',
};

const SECTION_COLORS = {
  crushing:    '#C0392B', milling:   '#2471A3', leaching:    '#1A7A4A',
  slurry:      '#1A7A4A', carbon:    '#1A7A4A', cyclone:     '#2471A3',
  thickener:   '#7D3C98', screen:    '#D35400', filterpress: '#1D6A96',
  gc:          '#B7950B', elution:   '#7D3C98', ils:         '#D35400',
  gold:        '#B8860B',
};

// ─── API HELPER ───────────────────────────────────────────────────────────────

async function api(endpoint, payload = {}) {
  try {
    const r = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, token: STATE.token }),
    });
    const data = await r.json();
    if (data && data.error === 'SESSION_EXPIRED') { doLogout(); return null; }
    return data;
  } catch (err) {
    console.error('API error:', endpoint, err);
    showToast('Network error — check connection', 'error');
    return null;
  }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────

function fmt(v, dec = 2) {
  if (v === '' || v === null || v === undefined) return '—';
  const n = parseFloat(v);
  return isNaN(n) ? String(v) : n.toFixed(dec);
}

function statusClass(s) {
  if (s === 'NORMAL')   return 'ok';
  if (s === 'WARNING')  return 'warn';
  if (s === 'CRITICAL') return 'crit';
  return 'none';
}

function pillHtml(s) {
  const c = statusClass(s);
  const lbl = s === 'NORMAL' ? 'OK' : s === 'NO_DATA' ? 'N/A' : (s || 'N/A');
  return `<span class="pill pill-${c}">${lbl}</span>`;
}

// ─── CLOCK ────────────────────────────────────────────────────────────────────

function startClock() {
  const el = document.getElementById('nav-clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
  };
  tick();
  if (STATE._clockInterval) clearInterval(STATE._clockInterval);
  STATE._clockInterval = setInterval(tick, 1000);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const user = document.getElementById('li-user').value.trim();
  const pass = document.getElementById('li-pass').value;
  const errEl = document.getElementById('li-err');
  const btn   = document.getElementById('li-btn');

  errEl.textContent = '';
  if (!user || !pass) { errEl.textContent = 'Enter username and password.'; return; }
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  let r;
  try {
    r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    }).then(x => x.json());
  } catch (e) {
    errEl.textContent = 'Cannot connect to server.';
    btn.disabled = false; btn.textContent = 'Sign In';
    return;
  }

  btn.disabled = false; btn.textContent = 'Sign In';

  if (!r || !r.success) {
    errEl.textContent = r ? r.error : 'Login failed.';
    return;
  }

  STATE.token     = r.token;
  STATE.role      = r.role;
  STATE.name      = r.name;
  STATE.roleLabel = r.roleLabel;

  document.getElementById('page-login').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('nav-name').textContent = r.name;
  document.getElementById('nav-role').textContent = r.roleLabel;

  // Show/hide nav tabs
  const canEntry   = ['supervisor','process1','process2','process3'].includes(r.role);
  const canTargets = ['supervisor','management'].includes(r.role);
  const isAdmin    = r.role === 'supervisor';

  document.getElementById('tab-entry').classList.toggle('hidden', !canEntry);
  document.getElementById('tab-targets').classList.toggle('hidden', !canTargets);
  document.getElementById('tab-report').classList.toggle('hidden', !canTargets);
  document.getElementById('tab-admin').classList.toggle('hidden', !isAdmin);

  // Set today
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  STATE.filterDate  = today;
  STATE.filterMonth = thisMonth;
  document.getElementById('dash-date').value  = today;
  document.getElementById('dash-month').value = thisMonth;
  document.getElementById('dash-from').value  = weekAgo;
  document.getElementById('dash-to').value    = today;
  document.getElementById('det-date').value   = today;
  document.getElementById('ent-date').value   = today;
  document.getElementById('al-date').value    = today;
  document.getElementById('al-month').value   = thisMonth;
  document.getElementById('report-month').value = thisMonth;

  populateEntrySheets();
  startClock();
  showPage('dashboard');
}

function doLogout() {
  if (STATE.token) api('logout', {});
  STATE.token = null; STATE.role = null;
  // Destroy all charts
  Object.values(STATE.charts).forEach(c => { try { c && c.destroy && c.destroy(); } catch (e) {} });
  STATE.charts = {};
  document.getElementById('app').classList.add('hidden');
  document.getElementById('page-login').style.display = 'flex';
  document.getElementById('li-user').value = '';
  document.getElementById('li-pass').value = '';
  document.getElementById('li-err').textContent = '';
}

// Enter key on login
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('li-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('li-user').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('li-pass').focus();
  });
});

// ─── PAGE NAVIGATION ──────────────────────────────────────────────────────────

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.remove('hidden');

  // Activate correct nav tab
  document.querySelectorAll('.nav-tab').forEach(t => {
    if (t.getAttribute('onclick') && t.getAttribute('onclick').includes("'" + name + "'")) {
      t.classList.add('active');
    }
  });

  if (name === 'dashboard') loadDashboard();
  else if (name === 'alerts') loadAlerts();
  else if (name === 'targets') loadTargets();
  else if (name === 'report') { /* wait for user to click Generate */ }
  else if (name === 'admin') initAdmin();
}

// ─── ALERTS PAGE ──────────────────────────────────────────────────────────────

function alSetMode(mode) {
  STATE.alertMode = mode;
  document.getElementById('al-vbtn-date').classList.toggle('active', mode === 'date');
  document.getElementById('al-vbtn-month').classList.toggle('active', mode === 'month');
  document.getElementById('al-date').style.display  = mode === 'date'  ? '' : 'none';
  document.getElementById('al-month').style.display = mode === 'month' ? '' : 'none';
}

async function loadAlerts() {
  const content = document.getElementById('alerts-content');
  const summary = document.getElementById('alerts-summary');
  content.innerHTML = skeletonCards(2);

  const payload = {};
  if ((STATE.alertMode || 'date') === 'month') {
    payload.month = document.getElementById('al-month').value || STATE.filterMonth;
  } else {
    payload.date = document.getElementById('al-date').value || STATE.filterDate;
  }

  const data = await api('alerts', payload);
  if (!data || data.error) {
    summary.innerHTML = '';
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error loading alerts'}</div>`;
    return;
  }

  summary.innerHTML = `
    <div class="kpi-s-tile ${data.critical ? 'crit' : ''}">
      <div class="kpi-s-val">${data.critical}</div><div class="kpi-s-label">Critical</div>
    </div>
    <div class="kpi-s-tile ${data.warning ? 'warn' : ''}">
      <div class="kpi-s-val">${data.warning}</div><div class="kpi-s-label">Warning</div>
    </div>
    <div class="kpi-s-tile">
      <div class="kpi-s-val">${data.total}</div><div class="kpi-s-label">Total · ${data.date || ''}</div>
    </div>`;

  if (!data.alerts.length) {
    content.innerHTML = '<div class="nodata" style="color:var(--ok)">✔ No critical or warning readings in this period.</div>';
    return;
  }

  const limitStr = (l) => {
    if (!l) return '';
    const parts = [];
    if (l.min !== null && !isNaN(l.min)) parts.push(`min ${l.min}`);
    if (l.max !== null && !isNaN(l.max)) parts.push(`max ${l.max}`);
    return parts.join(' / ');
  };

  content.innerHTML = `
    <div class="tbl-wrap"><table class="dtbl">
      <thead><tr><th>Status</th><th>Date</th><th>Time/Shift</th><th>Section</th><th>Parameter</th><th>Value</th><th>Allowed</th></tr></thead>
      <tbody>${data.alerts.map(a => `<tr>
        <td>${pillHtml(a.status)}</td>
        <td>${a.date || ''}</td>
        <td>${a.time || ''}</td>
        <td class="td-label"><a href="#" onclick="openSection('${a.sectionKey}');return false" style="color:var(--maroon)">${a.section}</a></td>
        <td>${a.param}</td>
        <td class="td-${statusClass(a.status)}">${fmt(a.value)} ${a.unit}</td>
        <td style="color:var(--txt3);font-size:11px">${limitStr(a.limit)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────

function exportSection() {
  if (!STATE.currentSec) { showToast('Open a section first', 'error'); return; }
  const params = new URLSearchParams({ token: STATE.token, section: STATE.currentSec });
  Object.entries(detFilterPayload()).forEach(([k, v]) => { if (v) params.set(k, v); });
  window.location.href = '/api/export/section?' + params.toString();
}

function exportReport() {
  const month = document.getElementById('report-month').value;
  if (!month) { showToast('Select a month first', 'error'); return; }
  const params = new URLSearchParams({ token: STATE.token, month });
  window.location.href = '/api/export/report?' + params.toString();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function setViewMode(mode) {
  STATE.filterMode = mode;
  ['date', 'month', 'range'].forEach(m => {
    const btn = document.getElementById('vbtn-' + m);
    if (btn) btn.classList.toggle('active', mode === m);
  });
  document.getElementById('dash-date').style.display       = mode === 'date'  ? '' : 'none';
  document.getElementById('dash-month').style.display      = mode === 'month' ? '' : 'none';
  document.getElementById('dash-range-wrap').style.display = mode === 'range' ? 'inline-flex' : 'none';
}

function dashFilterPayload() {
  const mode = STATE.filterMode;
  if (mode === 'month') return { month: document.getElementById('dash-month').value || STATE.filterMonth };
  if (mode === 'range') {
    return {
      from: document.getElementById('dash-from').value || null,
      to:   document.getElementById('dash-to').value   || null,
    };
  }
  return { date: document.getElementById('dash-date').value || STATE.filterDate };
}

function skeletonCards(n) {
  return Array.from({ length: n }, () => `
    <div class="skel-card">
      <div class="skel-line" style="width:55%"></div>
      <div class="skel-line" style="width:35%;height:10px"></div>
      <div class="skel-line" style="width:80%;height:10px"></div>
      <div class="skel-line" style="width:70%;height:10px"></div>
    </div>`).join('');
}

function renderKpiStrip(kpis) {
  const wrap = document.getElementById('dash-kpis');
  if (!kpis || !kpis.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = kpis.map(k => {
    const cls = k.status === 'CRITICAL' ? 'crit' : k.status === 'WARNING' ? 'warn' : '';
    return `<div class="kpi-s-tile ${cls}">
      <div class="kpi-s-val">${fmt(k.value, k.unit === 'g' || k.unit === 't' || k.unit === 'hrs' ? 1 : 0)}</div>
      <div class="kpi-s-label">${k.label}</div>
      <div class="kpi-s-unit">${k.unit || ''}</div>
    </div>`;
  }).join('');
}

async function loadDashboard() {
  const grid = document.getElementById('dash-grid');
  grid.innerHTML = skeletonCards(6);
  document.getElementById('dash-kpis').innerHTML =
    '<div class="kpi-s-tile"><div class="skel-line" style="width:60%"></div><div class="skel-line" style="width:80%;height:9px"></div></div>'.repeat(4);

  const data = await api('dashboard', dashFilterPayload());
  if (!data) return;

  document.getElementById('dash-info').textContent = data.date ? 'Showing: ' + data.date : '';
  renderKpiStrip(data.kpis);

  const sections = data.sections || {};
  const keys = Object.keys(sections);
  if (!keys.length) {
    grid.innerHTML = '<div class="nodata">No data available for this period.</div>';
    return;
  }

  grid.innerHTML = keys.map(key => {
    const sec = sections[key];
    const statusCls = statusClass(sec.status);
    const color = SECTION_COLORS[key] || 'var(--gold)';

    let bodyHtml = '';
    if (!sec.hasData) {
      bodyHtml = '<div style="color:var(--txt3);font-size:12px;font-style:italic;padding:8px 0">No data for this period</div>';
    } else if (!sec.flagged || sec.flagged.length === 0) {
      bodyHtml = '<div style="color:var(--ok);font-size:12px;font-weight:600;padding:8px 0">✔ All parameters healthy</div>';
    } else {
      const shown = sec.flagged.slice(0, 5);
      const more  = sec.flagged.length - 5;
      bodyHtml = shown.map(f => `
        <div class="flag-item">
          <span class="flag-label">${f.label}</span>
          <span class="flag-val ${statusClass(f.status)}">${fmt(f.value)} ${f.unit || ''}</span>
        </div>`).join('') +
        (more > 0 ? `<div style="font-size:11px;color:var(--txt3);padding-top:4px">+${more} more…</div>` : '');
    }

    return `
      <div class="sec-card ${statusCls}" style="--sec-color:${color}" onclick="openSection('${key}')">
        <div class="sec-card-header">
          <div>
            <div class="sec-card-label">${sec.label}</div>
          </div>
          ${pillHtml(sec.status)}
        </div>
        <div class="sec-card-body">${bodyHtml}</div>
        <div class="sec-card-footer">View Details ›</div>
      </div>`;
  }).join('');
}

// ─── SECTION DETAIL ───────────────────────────────────────────────────────────

function openSection(key) {
  STATE.currentSec  = key;
  STATE.detailMode  = STATE.filterMode;
  document.getElementById('det-date').value  = document.getElementById('dash-date').value  || STATE.filterDate;
  document.getElementById('det-month').value = document.getElementById('dash-month').value || STATE.filterMonth || '';
  document.getElementById('det-from').value  = document.getElementById('dash-from').value  || '';
  document.getElementById('det-to').value    = document.getElementById('dash-to').value    || '';
  detSetMode(STATE.detailMode);
  showPage('detail');
  loadDetail();
}

function detSetMode(mode) {
  STATE.detailMode = mode;
  ['date', 'month', 'range'].forEach(m => {
    const btn = document.getElementById('det-vbtn-' + m);
    if (btn) btn.classList.toggle('active', mode === m);
  });
  document.getElementById('det-date').style.display        = mode === 'date'  ? '' : 'none';
  document.getElementById('det-month').style.display       = mode === 'month' ? '' : 'none';
  document.getElementById('det-range-wrap').style.display  = mode === 'range' ? 'inline-flex' : 'none';
}

function detFilterPayload() {
  if (STATE.detailMode === 'month') return { month: document.getElementById('det-month').value };
  if (STATE.detailMode === 'range') {
    return {
      from: document.getElementById('det-from').value || null,
      to:   document.getElementById('det-to').value   || null,
    };
  }
  return { date: document.getElementById('det-date').value };
}

async function loadDetail() {
  const content = document.getElementById('det-content');
  content.innerHTML = `
    <div class="skel-card" style="height:90px"><div class="skel-line" style="width:40%"></div><div class="skel-line" style="width:65%"></div></div>
    <div class="skel-card" style="height:220px;margin-top:14px"><div class="skel-line" style="width:30%"></div><div class="skel-line" style="width:90%;height:140px"></div></div>`;

  // Destroy old charts
  Object.values(STATE.charts).forEach(c => { try { c && c.destroy && c.destroy(); } catch (e) {} });
  STATE.charts = {};

  const payload = { section: STATE.currentSec, ...detFilterPayload() };

  const data = await api('section', payload);
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error loading data'}</div>`;
    return;
  }

  document.getElementById('det-title').textContent = data.label;
  const modeLbl = STATE.detailMode === 'date' ? 'Date: ' : STATE.detailMode === 'month' ? 'Month: ' : 'Range: ';
  document.getElementById('det-sub').textContent   = modeLbl + (data.date || '');
  STATE.lastSectionData = data;

  if (!data.hasData) {
    content.innerHTML = '<div class="nodata">No data for this period.</div>';
    return;
  }

  content.innerHTML = renderSection(data);

  // Build charts after DOM settles
  setTimeout(() => buildSectionCharts(data), 60);
}

// ─── SECTION RENDERER ─────────────────────────────────────────────────────────

function renderSection(data) {
  const key = data.section;
  if (key === 'crushing')    return renderCrushing(data);
  if (key === 'milling')     return renderMilling(data);
  if (key === 'leaching')    return renderLeaching(data);
  if (key === 'filterpress') return renderFilterPress(data);
  if (key === 'slurry')      return renderGenericSection(data);
  if (key === 'carbon')      return renderCarbon(data);
  if (key === 'cyclone')     return renderGenericSection(data);
  if (key === 'screen')      return renderGenericSection(data);
  if (key === 'thickener')   return renderGenericSection(data);
  if (key === 'gc')          return renderGenericSection(data);
  if (key === 'elution')     return renderGenericSection(data);
  if (key === 'ils')         return renderGenericSection(data);
  if (key === 'gold')        return renderGold(data);
  return renderGenericSection(data);
}

// ── Crushing ──────────────────────────────────────────────────────────────────
function renderCrushing(data) {
  const rows = data.rows || [];
  // Compute KPIs
  let totalHrs = 0, totalProd = 0, tphVals = [];
  rows.forEach(r => {
    totalHrs  += parseFloat(r['Running Hours']) || 0;
    totalProd += parseFloat(r['Production'])    || 0;
    const t = parseFloat(r['TPH']);
    if (!isNaN(t)) tphVals.push(t);
  });
  const avgTph = tphVals.length ? (tphVals.reduce((a,b)=>a+b,0)/tphVals.length) : 0;

  return `
    <div class="kpi-row-3">
      <div class="kpi-tile">
        <div class="kpi-label">Running Hours</div>
        <div class="kpi-val">${fmt(totalHrs,1)}</div>
        <div class="kpi-unit">hrs</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Production</div>
        <div class="kpi-val gold">${fmt(totalProd,0)}</div>
        <div class="kpi-unit">tonnes</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Avg TPH</div>
        <div class="kpi-val">${fmt(avgTph,1)}</div>
        <div class="kpi-unit">t/hr</div>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Production Trend</div>
      <div class="chart-canvas-wrap"><canvas id="chart-crushing-prod"></canvas></div>
    </div>
    ${chemStrip(data.chemicals)}
    ${stoppagesHtml(data.stoppages)}
    ${genericTableHtml(data)}`;
}

// ── Milling ───────────────────────────────────────────────────────────────────
function renderMilling(data) {
  const rows = data.rows || [];
  let totalHrs = 0, totalProd = 0, fgVals = [];
  rows.forEach(r => {
    totalHrs  += parseFloat(r['Running Hrs']) || 0;
    totalProd += parseFloat(r['Production'])  || 0;
    const fg = parseFloat(r['Feed Grade']);
    if (!isNaN(fg)) fgVals.push(fg);
  });
  const avgFG = fgVals.length ? (fgVals.reduce((a,b)=>a+b,0)/fgVals.length) : 0;

  return `
    <div class="kpi-row-3">
      <div class="kpi-tile">
        <div class="kpi-label">Running Hours</div>
        <div class="kpi-val">${fmt(totalHrs,1)}</div>
        <div class="kpi-unit">hrs</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Production</div>
        <div class="kpi-val gold">${fmt(totalProd,0)}</div>
        <div class="kpi-unit">tonnes</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Avg Feed Grade</div>
        <div class="kpi-val">${fmt(avgFG,2)}</div>
        <div class="kpi-unit">g/t</div>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Milling Trend</div>
      <div class="chart-canvas-wrap"><canvas id="chart-milling-prod"></canvas></div>
    </div>
    ${chemStrip(data.chemicals)}
    ${stoppagesHtml(data.stoppages)}
    ${genericTableHtml(data)}`;
}

// ── Leaching ──────────────────────────────────────────────────────────────────
function renderLeaching(data) {
  const leachParam = 'nacn';
  return `
    <div class="section-block">
      <div class="section-block-title">Leaching Tank Heatmap</div>
      <div class="param-sel-btns">
        <button class="param-sel-btn active" id="lhm-btn-nacn" onclick="switchLeachParam('nacn')">NaCN (ppm)</button>
        <button class="param-sel-btn" id="lhm-btn-ph"   onclick="switchLeachParam('ph')">pH</button>
        <button class="param-sel-btn" id="lhm-btn-au"   onclick="switchLeachParam('au')">Au in Liquor</button>
        <button class="param-sel-btn" id="lhm-btn-do"   onclick="switchLeachParam('do')">DO (ppm)</button>
      </div>
      <div id="leach-heatmap-wrap">${renderLeachingHeatmap(data, leachParam)}</div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Leaching Trend — LT9 NaCN</div>
      <div class="chart-canvas-wrap"><canvas id="chart-leach-main"></canvas></div>
    </div>
    ${stoppagesHtml(data.stoppages)}`;
}

window._leachData = null;
function switchLeachParam(param) {
  document.querySelectorAll('.param-sel-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('lhm-btn-' + param);
  if (btn) btn.classList.add('active');
  if (window._leachData) {
    document.getElementById('leach-heatmap-wrap').innerHTML = renderLeachingHeatmap(window._leachData, param);
  }
}

function renderLeachingHeatmap(data, param) {
  const LT_TANKS = ['LT4','LT5','LT6','LT7','LT8','LT9','LT10'];
  const DT_TANKS = ['DT1','DT4'];
  const paramKeyMap = {
    nacn: t => `${t} NaCN (ppm)`,
    ph:   t => `${t} pH`,
    au:   t => `${t} Au in Liquor (ppm)`,
    do:   t => `${t} DO (ppm)`,
    cn:   t => `${t} CN (ppm)`,
  };
  const rows = data.rows || [];
  if (!rows.length) return '<div class="nodata">No data</div>';

  const showRows = STATE.detailMode !== 'date' ? rows.slice(-14) : rows;
  const timeLabels = showRows.map(r => r.__time || r.__date || '');

  let html = `<div class="leach-heatmap"><table class="heatmap-table">
    <thead><tr><th style="text-align:left">Tank</th>${timeLabels.map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>`;

  LT_TANKS.forEach(tank => {
    const key = (paramKeyMap[param] || paramKeyMap.nacn)(tank);
    html += `<tr><td class="hm-tank-label" style="color:#B8860B;background:var(--bg3)">${tank}</td>`;
    showRows.forEach(row => {
      const v = row[key];
      const s = row[key + '__status'];
      const cls = !s || s === 'NO_DATA' ? 'hm-na' : s === 'NORMAL' ? 'hm-ok' : s === 'WARNING' ? 'hm-warn' : 'hm-crit';
      html += `<td class="${cls}">${(v !== '' && v !== undefined && v !== null) ? fmt(v,2) : '—'}</td>`;
    });
    html += '</tr>';
  });

  if (param === 'nacn' || param === 'ph' || param === 'au') {
    const dtParamMap = { nacn: 'cn', ph: 'ph', au: 'au' };
    html += `<tr class="hm-section-sep"><td colspan="${timeLabels.length+1}">Discharge Tanks</td></tr>`;
    DT_TANKS.forEach(tank => {
      const dpKey = dtParamMap[param] || param;
      const key = dpKey === 'cn' ? `${tank} CN (ppm)` : dpKey === 'ph' ? `${tank} pH` : `${tank} Au in Liquor (ppm)`;
      html += `<tr><td class="hm-tank-label hm-dt-header">${tank}</td>`;
      showRows.forEach(row => {
        const v = row[key];
        const s = row[key + '__status'];
        const cls = !s || s === 'NO_DATA' ? 'hm-na' : s === 'NORMAL' ? 'hm-ok' : s === 'WARNING' ? 'hm-warn' : 'hm-crit';
        html += `<td class="${cls}">${(v !== '' && v !== undefined && v !== null) ? fmt(v,2) : '—'}</td>`;
      });
      html += '</tr>';
    });
  }

  html += '</tbody></table></div>';
  return html;
}

// ── Filter Press ──────────────────────────────────────────────────────────────
function renderFilterPress(data) {
  const rows = data.rows || [];
  const amRows = rows.filter(r => String(r.__shift||'').toUpperCase().includes('AM'));
  const pmRows = rows.filter(r => String(r.__shift||'').toUpperCase().includes('PM'));

  const avgAu = (arr) => {
    const vals = arr.map(r => parseFloat(r['Au'])).filter(v => !isNaN(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  };

  return `
    <div class="kpi-row-2">
      <div class="kpi-tile" style="--kpi-color:#2471A3">
        <div class="kpi-label">AM Shift — Avg Au</div>
        <div class="kpi-val">${avgAu(amRows) !== null ? fmt(avgAu(amRows),2) : '—'}</div>
        <div class="kpi-unit">ppm &nbsp;·&nbsp; ${amRows.length} readings</div>
      </div>
      <div class="kpi-tile" style="--kpi-color:#C0392B">
        <div class="kpi-label">PM Shift — Avg Au</div>
        <div class="kpi-val">${avgAu(pmRows) !== null ? fmt(avgAu(pmRows),2) : '—'}</div>
        <div class="kpi-unit">ppm &nbsp;·&nbsp; ${pmRows.length} readings</div>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Au by Shift</div>
      <div class="chart-canvas-wrap"><canvas id="chart-fp-au"></canvas></div>
    </div>
    ${stoppagesHtml(data.stoppages)}
    ${genericTableHtml(data)}`;
}

// ── Carbon ────────────────────────────────────────────────────────────────────
function renderCarbon(data) {
  const rows = data.rows || [];
  // Latest row summary
  const latest = rows[rows.length - 1];
  return `
    ${latest ? `<div class="section-block">
      <div class="section-block-title">Latest Reading — ${latest.__date}</div>
      <div class="kpi-row-3">
        ${['LT7','LT8','LT9'].map(t => {
          const v = latest[`${t} Carbon (g/L)`];
          return `<div class="kpi-tile"><div class="kpi-label">${t} Carbon</div>
            <div class="kpi-val">${v !== '' && v !== undefined ? fmt(v,1) : '—'}</div>
            <div class="kpi-unit">g/L</div></div>`;
        }).join('')}
      </div>
    </div>` : ''}
    ${genericTableHtml(data)}`;
}

// ── Gold ──────────────────────────────────────────────────────────────────────
function renderGold(data) {
  const rows = data.rows || [];
  let totalMass = 0, totalAu = 0;
  rows.forEach(r => {
    totalMass += parseFloat(r['Dore Mass (g)'])  || 0;
    totalAu   += parseFloat(r['Au Content (g)']) || 0;
  });

  return `
    <div class="kpi-row-2">
      <div class="kpi-tile" style="--kpi-color:var(--gold)">
        <div class="kpi-label">Total Dore Mass</div>
        <div class="kpi-val gold">${fmt(totalMass,1)}</div>
        <div class="kpi-unit">g</div>
      </div>
      <div class="kpi-tile" style="--kpi-color:var(--gold)">
        <div class="kpi-label">Total Au Content</div>
        <div class="kpi-val gold">${fmt(totalAu,1)}</div>
        <div class="kpi-unit">g</div>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Gold Production Trend</div>
      <div class="chart-canvas-wrap"><canvas id="chart-gold-prod"></canvas></div>
    </div>
    ${genericTableHtml(data)}`;
}

// ── Generic ───────────────────────────────────────────────────────────────────
function renderGenericSection(data) {
  return `${chemStrip(data.chemicals)}${stoppagesHtml(data.stoppages)}${genericTableHtml(data)}`;
}

// ─── SHARED HTML HELPERS ──────────────────────────────────────────────────────

function chemStrip(chemicals) {
  if (!chemicals || !chemicals.length) return '';
  return `<div class="section-block">
    <div class="section-block-title">Chemical Usage</div>
    <div class="chem-strip">
      ${chemicals.map(c => `<div class="chem-badge ${c.hasData ? 'has-data' : ''}">
        ${c.name}: <strong>${c.hasData ? fmt(c.total,1) : '—'}</strong>
      </div>`).join('')}
    </div>
  </div>`;
}

function stoppagesHtml(stoppages) {
  if (!stoppages || !stoppages.length) return '';
  return `
    <div class="section-block">
      <div class="section-block-title">Stoppages</div>
      <div class="tbl-wrap">
        <table class="dtbl">
          <thead><tr>
            <th>Date</th><th>Section</th><th>Stop</th><th>Resume</th>
            <th>Hours</th><th>Dept</th><th>Reason</th>
          </tr></thead>
          <tbody>
            ${stoppages.map(s => `<tr>
              <td>${s.date||''}</td><td>${s.section||''}</td>
              <td>${s.stop||''}</td><td>${s.start||''}</td>
              <td class="td-val">${fmt(s.hrs,2)}</td>
              <td>${s.dept||''}</td><td>${s.reason||''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function genericTableHtml(data) {
  if (!data.rows || !data.rows.length) return '<div class="nodata">No data rows.</div>';
  const params = (data.params || []).filter(p => p.key !== 'Date' && p.key !== 'Time' && p.key !== 'Shift');
  const hasTime  = data.rows[0]?.__time  !== undefined;
  const hasShift = data.rows[0]?.__shift !== undefined;

  return `
    <div class="section-block">
      <div class="section-block-title">All Readings</div>
      <div class="tbl-wrap">
        <table class="dtbl">
          <thead><tr>
            <th>Date</th>
            ${hasTime  ? '<th>Time</th>'  : ''}
            ${hasShift ? '<th>Shift</th>' : ''}
            ${params.map(p => `<th>${p.label}${p.unit ? `<br><span style="font-weight:400;color:var(--txt3)">${p.unit}</span>` : ''}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${data.rows.map(row => `<tr>
              <td>${row.__date||''}</td>
              ${hasTime  ? `<td>${row.__time||''}</td>` : ''}
              ${hasShift ? `<td>${row.__shift||''}</td>` : ''}
              ${params.map(p => {
                const v = row[p.key];
                const s = row[p.key + '__status'];
                const cls = s ? 'td-' + statusClass(s) : 'td-val';
                const display = (v !== '' && v !== null && v !== undefined)
                  ? (p.isText || p.isTime || p.isSelect ? String(v) : fmt(v,2))
                  : '—';
                return `<td class="${cls}">${display}</td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ─── CHART BUILDER ────────────────────────────────────────────────────────────

/**
 * Builds flat-line datasets that draw a limit band on a chart:
 * dashed red min/max lines with a light green fill for the acceptable zone.
 * lim: { min, max, warnMin, warnMax } (nulls skipped). Band lines are
 * excluded from the legend and tooltips.
 */
function limitBandDatasets(lim, labels, yAxisID) {
  if (!lim) return [];
  const flat = v => labels.map(() => v);
  const ds = [];
  const has = v => v !== null && v !== undefined && !isNaN(v);
  const line = (v, color, dash, fill) => ({
    label: '__band__', data: flat(v), borderColor: color, borderWidth: 1.5,
    borderDash: dash, pointRadius: 0, pointHitRadius: 0, fill: fill || false,
    type: 'line', yAxisID: yAxisID || 'y', order: 100,
  });
  if (has(lim.max)) ds.push(line(lim.max, 'rgba(185,28,28,.55)', [6, 4]));
  if (has(lim.min)) {
    const minLine = line(lim.min, 'rgba(185,28,28,.55)', [6, 4]);
    if (has(lim.max)) { minLine.fill = '-1'; minLine.backgroundColor = 'rgba(26,122,74,.07)'; }
    ds.push(minLine);
  }
  if (has(lim.warnMax)) ds.push(line(lim.warnMax, 'rgba(180,83,9,.45)', [2, 3]));
  if (has(lim.warnMin)) ds.push(line(lim.warnMin, 'rgba(180,83,9,.45)', [2, 3]));
  return ds;
}

function buildChart(canvasId, labels, datasets, scales = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (STATE.charts[canvasId]) {
    try { STATE.charts[canvasId].destroy(); } catch (e) {}
    delete STATE.charts[canvasId];
  }
  if (typeof Chart === 'undefined') return;

  STATE.charts[canvasId] = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { boxWidth: 12, font: { size: 10 }, filter: item => item.text !== '__band__' },
        },
        tooltip: { filter: item => item.dataset.label !== '__band__' },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: {
          beginAtZero: false,
          grid: { color: 'rgba(0,0,0,.05)' },
          ticks: { font: { size: 10 } },
          ...(scales.y || {}),
        },
        ...(scales.y2 ? {
          y2: { position: 'right', beginAtZero: false, grid: { display: false }, ticks: { font: { size: 10 } }, ...scales.y2 }
        } : {}),
      },
    },
  });
}

function buildSectionCharts(data) {
  const key   = data.section;
  const isMonth = data.isAggregate || STATE.detailMode !== 'date';
  const rows  = isMonth ? (data.dailyRows && data.dailyRows.length ? data.dailyRows : data.rows) : data.rows;
  if (!rows.length) return;

  window._leachData = data; // store for param switching

  const labels = rows.map(r => r.__date || r.__time || '');

  if (key === 'crushing') {
    const prodVals = rows.map(r => { const v = parseFloat(r['Production']);    return isNaN(v) ? null : v; });
    const tphVals  = rows.map(r => { const v = parseFloat(r['TPH']);           return isNaN(v) ? null : v; });
    buildChart('chart-crushing-prod', labels, [
      { label: 'Production (t)', data: prodVals, backgroundColor: 'rgba(192,57,43,.65)', type: 'bar',  yAxisID: 'y'  },
      { label: 'TPH (t/hr)',     data: tphVals,  borderColor: '#2471A3', fill: false, type: 'line', yAxisID: 'y2', tension: .3, pointRadius: 3 },
    ], { y: { title: { display: true, text: 't' } }, y2: { title: { display: true, text: 't/hr' } } });
  }

  if (key === 'milling') {
    const prodVals = rows.map(r => { const v = parseFloat(r['Production']); return isNaN(v) ? null : v; });
    const fgVals   = rows.map(r => { const v = parseFloat(r['Feed Grade']); return isNaN(v) ? null : v; });
    buildChart('chart-milling-prod', labels, [
      { label: 'Production (t)', data: prodVals, backgroundColor: 'rgba(36,113,163,.65)', type: 'bar',  yAxisID: 'y'  },
      { label: 'Feed Grade (g/t)', data: fgVals, borderColor: '#B8860B', fill: false, type: 'line', yAxisID: 'y2', tension: .3, pointRadius: 3 },
    ], { y: { title: { display: true, text: 't' } }, y2: { title: { display: true, text: 'g/t' } } });
  }

  if (key === 'leaching') {
    const nacnVals = rows.map(r => { const v = parseFloat(r['LT9 NaCN (ppm)']); return isNaN(v) ? null : v; });
    const auVals   = rows.map(r => { const v = parseFloat(r['LT9 Au in Liquor (ppm)']); return isNaN(v) ? null : v; });
    const auLim = (data.limits || {})['LT_AU_LT9'];
    buildChart('chart-leach-main', labels, [
      { label: 'LT9 NaCN (ppm)', data: nacnVals, borderColor: '#1A7A4A', fill: false, tension: .3, pointRadius: 3 },
      { label: 'LT9 Au (ppm)',   data: auVals,   borderColor: '#B8860B', fill: false, tension: .3, pointRadius: 3, yAxisID: 'y2' },
      ...limitBandDatasets(auLim, labels, 'y2'),
    ], { y2: { title: { display: true, text: 'Au ppm' } } });
  }

  if (key === 'filterpress') {
    const auVals = rows.map(r => { const v = parseFloat(r['Au']); return isNaN(v) ? null : v; });
    const labelsWithShift = rows.map(r => (r.__shift ? r.__shift.slice(0,2) : '') + ' ' + (r.__date||''));
    buildChart('chart-fp-au', labelsWithShift, [
      { label: 'Au (ppm)', data: auVals, borderColor: '#B8860B', fill: false, tension: .3, pointRadius: 4 },
    ], {});
  }

  if (key === 'gold') {
    const massVals = rows.map(r => { const v = parseFloat(r['Dore Mass (g)']); return isNaN(v) ? null : v; });
    buildChart('chart-gold-prod', labels, [
      { label: 'Dore Mass (g)', data: massVals, backgroundColor: 'rgba(184,134,11,.6)', type: 'bar' },
    ], {});
  }
}

// ─── ENTRY FORM ───────────────────────────────────────────────────────────────

function populateEntrySheets() {
  const select = document.getElementById('ent-sheet');
  select.innerHTML = '<option value="">— Select —</option>';

  const sheetsByRole = {
    supervisor: [
      'Crushing','Milling','Chemical Consumption','Leaching Tanks','Slurry Samples',
      'Carbon in Leaching Tank','Filter Press','Cyclone','Screen','Thickener',
      'GC','Elution','ILS','Gold','Stoppage Reason','Stock Inward Log',
    ],
    process1:   ['Crushing','Chemical Consumption','Stoppage Reason','Stock Inward Log'],
    process2:   ['Milling','Leaching Tanks','Slurry Samples','Carbon in Leaching Tank',
                 'Filter Press','Cyclone','Screen','Thickener','Chemical Consumption','Stoppage Reason','Stock Inward Log'],
    process3:   ['GC','Elution','ILS','Gold','Chemical Consumption','Stoppage Reason','Stock Inward Log'],
    management: [], meeting: [],
  };

  const sheets = sheetsByRole[STATE.role] || [];
  sheets.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    select.appendChild(opt);
  });
}

async function loadEntryForm() {
  const sheet      = document.getElementById('ent-sheet').value;
  const paramsDiv  = document.getElementById('ent-params');
  const submitCard = document.getElementById('ent-submit-card');
  const sheetLbl   = document.getElementById('ent-sheet-lbl');

  if (!sheet) { paramsDiv.innerHTML = ''; submitCard.style.display = 'none'; sheetLbl.textContent = 'Select Section'; return; }
  sheetLbl.textContent = sheet;
  paramsDiv.innerHTML = '<div class="loading"><div class="spinner"></div>Loading form…</div>';

  // Time/shift
  const leachSheets  = ['Leaching Tanks'];
  const shiftSheets  = ['Filter Press','Cyclone'];
  const timeRow      = document.getElementById('ent-time-row');
  const timeSelect   = document.getElementById('ent-time');
  const timeLabel    = document.getElementById('ent-time-label');

  if (leachSheets.includes(sheet)) {
    timeRow.style.display = '';
    timeLabel.textContent = 'Reading Time';
    timeSelect.innerHTML = ['03:00','07:00','11:00','15:00','19:00','23:00'].map(t =>
      `<option value="${t}">${t}</option>`).join('');
  } else if (shiftSheets.includes(sheet)) {
    timeRow.style.display = '';
    timeLabel.textContent = 'Shift';
    timeSelect.innerHTML = ['AM (00:00-12:00)','PM (12:00-00:00)'].map(t =>
      `<option value="${t}">${t}</option>`).join('');
  } else {
    timeRow.style.display = 'none';
  }

  const config = await api('entry-config', { sheet });
  if (!config || config.error) {
    paramsDiv.innerHTML = `<div class="nodata">${config ? config.error : 'Error loading form'}</div>`;
    return;
  }

  paramsDiv.innerHTML = buildEntryFormHtml(config.params);
  submitCard.style.display = '';
}

function buildEntryFormHtml(params) {
  const grouped   = {};
  const ungrouped = [];

  params.forEach(p => {
    if (p.tank) {
      const g = p.tankGroup || 'Other';
      if (!grouped[g])       grouped[g] = {};
      if (!grouped[g][p.tank]) grouped[g][p.tank] = [];
      grouped[g][p.tank].push(p);
    } else {
      ungrouped.push(p);
    }
  });

  let html = '';

  if (ungrouped.length) {
    html += '<div class="form-card"><div class="param-grid">';
    ungrouped.forEach(p => { html += paramInputHtml(p); });
    html += '</div></div>';
  }

  Object.entries(grouped).forEach(([group, tanks]) => {
    html += `<div class="form-card"><div class="form-card-title">${group} Tanks</div>`;
    Object.entries(tanks).forEach(([tank, tparams]) => {
      html += `<div class="param-group"><div class="param-group-title">${tank}</div><div class="param-grid">`;
      tparams.forEach(p => { html += paramInputHtml(p); });
      html += '</div></div>';
    });
    html += '</div>';
  });

  return html || '<div class="nodata">No parameters defined for this sheet.</div>';
}

function paramInputHtml(p) {
  const safeKey = p.key.replace(/[^a-zA-Z0-9]/g, '_');
  const id = 'param_' + safeKey;
  let inputHtml = '';

  if (p.autoCalc) {
    inputHtml = `<div class="param-auto-note">Calculated automatically</div>`;
  } else if (p.isOverflow) {
    inputHtml = `<select id="${id}" name="${p.key}">
      <option value="">—</option><option>No</option><option>Yes</option></select>`;
  } else if (p.isSelect && p.options) {
    inputHtml = `<select id="${id}" name="${p.key}">
      <option value="">—</option>${p.options.map(o=>`<option>${o}</option>`).join('')}</select>`;
  } else if (p.isTime) {
    inputHtml = `<input type="time" id="${id}" name="${p.key}">`;
  } else if (p.isText) {
    inputHtml = `<input type="text" id="${id}" name="${p.key}" placeholder="${p.label}">`;
  } else {
    inputHtml = `<input type="number" id="${id}" name="${p.key}" step="any" placeholder="—">
      ${p.limitDisplay ? `<div class="param-hint">Limits: ${p.limitDisplay} ${p.unit||''}</div>` : ''}`;
  }

  return `<div class="param-iw">
    <label>${p.label}${p.unit ? ` <span style="color:var(--txt3);font-size:10px">${p.unit}</span>` : ''}</label>
    ${inputHtml}
  </div>`;
}

async function submitEntry() {
  const sheet   = document.getElementById('ent-sheet').value;
  const date    = document.getElementById('ent-date').value;
  const notes   = document.getElementById('ent-notes').value;
  const timeRow = document.getElementById('ent-time-row');
  const shift   = timeRow.style.display !== 'none' ? document.getElementById('ent-time').value : '';

  if (!sheet || !date) { showToast('Select a sheet and date first', 'error'); return; }

  const values = {};
  document.querySelectorAll('#ent-params [name]').forEach(el => {
    if (el.value.trim() !== '') values[el.getAttribute('name')] = el.value.trim();
  });

  const btn = document.getElementById('ent-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const result = await api('submit', { sheet, date, shift, notes, values });
  btn.disabled = false; btn.textContent = 'Submit Entry';

  const msg = document.getElementById('ent-msg');
  if (result && result.success) {
    msg.className = 'form-msg success'; msg.style.display = 'block';
    msg.textContent = `Saved successfully to ${sheet}`;
    showToast('Entry saved successfully');
    // Clear numeric fields
    document.querySelectorAll('#ent-params input[type="number"]').forEach(el => { el.value = ''; });
    document.getElementById('ent-notes').value = '';
    setTimeout(() => { msg.style.display = 'none'; }, 5000);
  } else {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = result ? result.error : 'Save failed — check connection';
    showToast(result ? result.error : 'Save failed', 'error');
  }
}

// ─── TARGETS PAGE ─────────────────────────────────────────────────────────────

async function loadTargets() {
  const content = document.getElementById('targets-content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  const data = await api('targets');
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error'}</div>`;
    return;
  }

  if (!data.length) {
    content.innerHTML = '<div class="nodata">No targets set yet. Click "+ Add Target" to add one.</div>';
    return;
  }

  const byMonth = {};
  data.forEach(t => { if (!byMonth[t.month]) byMonth[t.month] = []; byMonth[t.month].push(t); });
  const months = Object.keys(byMonth).sort().reverse();

  content.innerHTML = months.map(m => `
    <div class="section-block">
      <div class="section-block-title">${m}</div>
      <div class="tbl-wrap"><table class="dtbl">
        <thead><tr><th>ID</th><th>Parameter</th><th>Unit</th><th>Target</th><th>Notes</th><th>Set By</th><th>Action</th></tr></thead>
        <tbody>${byMonth[m].map(t => `<tr>
          <td class="td-gold">${t.paramId}</td>
          <td class="td-label">${t.param}</td>
          <td class="td-unit">${t.unit}</td>
          <td style="color:var(--maroon);font-weight:700;font-family:var(--mono)">${fmt(t.target,2)}</td>
          <td>${t.notes||''}</td>
          <td style="color:var(--txt3);font-size:11px">${t.setBy||''}</td>
          <td><button class="save-lim" onclick='editTarget(${JSON.stringify(t)})'>Edit</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('');
}

function openTargetModal() {
  document.getElementById('modal-target-title').textContent = 'Add Target';
  document.getElementById('tgt-month').value    = '';
  document.getElementById('tgt-param-id').value = '';
  document.getElementById('tgt-param').value    = '';
  document.getElementById('tgt-unit').value     = '';
  document.getElementById('tgt-value').value    = '';
  document.getElementById('tgt-notes').value    = '';
  document.getElementById('tgt-rownum').value   = '';
  document.getElementById('tgt-msg').style.display = 'none';
  document.getElementById('modal-target').classList.remove('hidden');
}

function editTarget(t) {
  document.getElementById('modal-target-title').textContent = 'Edit Target';
  document.getElementById('tgt-month').value    = t.month || '';
  document.getElementById('tgt-param-id').value = t.paramId || '';
  document.getElementById('tgt-param').value    = t.param  || '';
  document.getElementById('tgt-unit').value     = t.unit   || '';
  document.getElementById('tgt-value').value    = t.target || '';
  document.getElementById('tgt-notes').value    = t.notes  || '';
  document.getElementById('tgt-rownum').value   = t.rowNum || '';
  document.getElementById('tgt-msg').style.display = 'none';
  document.getElementById('modal-target').classList.remove('hidden');
}

async function saveTarget() {
  const month   = document.getElementById('tgt-month').value;
  const paramId = document.getElementById('tgt-param-id').value.trim();
  const param   = document.getElementById('tgt-param').value.trim();
  const unit    = document.getElementById('tgt-unit').value.trim();
  const target  = parseFloat(document.getElementById('tgt-value').value);
  const notes   = document.getElementById('tgt-notes').value.trim();
  const rowNum  = document.getElementById('tgt-rownum').value;
  const msg     = document.getElementById('tgt-msg');

  if (!month || !paramId) {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = 'Month and Param ID are required.'; return;
  }

  const result = await api('targets/save', { month, paramId, param, unit, target: isNaN(target) ? 0 : target, notes, rowNum: rowNum || null });
  if (result && result.success) {
    closeModal('target'); showToast('Target saved'); loadTargets();
  } else {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = result ? result.error : 'Save failed';
  }
}

// ─── MONTHLY REPORT ───────────────────────────────────────────────────────────

async function loadReport() {
  const month = document.getElementById('report-month').value;
  if (!month) { showToast('Select a month first', 'error'); return; }

  const content = document.getElementById('report-content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Generating report…</div>';

  const data = await api('report', { month });
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error generating report'}</div>`;
    return;
  }

  let html = `<div style="margin-bottom:8px;font-size:12px;color:var(--txt3)">Report for: <strong>${month}</strong></div>`;
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">';

  // Crushing
  if (data.crushing) {
    const c = data.crushing;
    html += `<div class="report-card">
      <div class="rc-title" style="color:var(--crit)">⛏ Crushing</div>
      <div class="rc-kpi-grid">
        <div class="rc-kpi-item"><div class="rc-kpi-val">${fmt(c.runHours,1)}</div><div class="rc-kpi-unit">hrs</div><div class="rc-kpi-lbl">Running Hours</div></div>
        <div class="rc-kpi-item"><div class="rc-kpi-val gold">${fmt(c.production,0)}</div><div class="rc-kpi-unit">t</div><div class="rc-kpi-lbl">Production</div></div>
        <div class="rc-kpi-item"><div class="rc-kpi-val">${fmt(c.avgTph,1)}</div><div class="rc-kpi-unit">t/hr</div><div class="rc-kpi-lbl">Avg TPH</div></div>
      </div>
    </div>`;
  }

  // Milling
  if (data.milling) {
    const m = data.milling;
    html += `<div class="report-card">
      <div class="rc-title" style="color:#2471A3">⚙ Milling</div>
      <div class="rc-kpi-grid">
        <div class="rc-kpi-item"><div class="rc-kpi-val">${fmt(m.runHours,1)}</div><div class="rc-kpi-unit">hrs</div><div class="rc-kpi-lbl">Running Hours</div></div>
        <div class="rc-kpi-item"><div class="rc-kpi-val gold">${fmt(m.production,0)}</div><div class="rc-kpi-unit">t</div><div class="rc-kpi-lbl">Production</div></div>
        <div class="rc-kpi-item"><div class="rc-kpi-val">${fmt(m.feedGrade,2)}</div><div class="rc-kpi-unit">g/t</div><div class="rc-kpi-lbl">Avg Feed Grade</div></div>
      </div>
    </div>`;
  }

  html += '</div>';

  // Chemicals
  if (data.chemicals && data.chemicals.length) {
    const hasAny = data.chemicals.some(c => c.total > 0);
    if (hasAny) {
      html += `<div class="report-card" style="margin-bottom:14px">
        <div class="rc-title">🧪 Chemical Consumption</div>
        <div class="tbl-wrap"><table class="dtbl">
          <thead><tr><th>Chemical</th><th>Unit</th><th>Total Consumed</th></tr></thead>
          <tbody>${data.chemicals.filter(c => c.total > 0).map(c => `<tr>
            <td class="td-label">${c.name}</td>
            <td class="td-unit">${c.unit}</td>
            <td class="td-val">${fmt(c.total,1)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    }
  }

  // Stoppages
  if (data.stoppages) {
    const s = data.stoppages;
    html += `<div class="report-card" style="margin-bottom:14px">
      <div class="rc-title">🛑 Stoppage Analysis — Total: ${fmt(s.total,1)} hrs</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:12px">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--txt2);margin-bottom:8px;text-transform:uppercase">By Section</div>
          ${(s.bySection||[]).map(x => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bdr);font-size:12px">
            <span style="color:var(--txt2)">${x.section}</span>
            <span class="td-val">${fmt(x.hrs,1)} hrs</span>
          </div>`).join('') || '<div class="nodata" style="padding:8px 0">No data</div>'}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--txt2);margin-bottom:8px;text-transform:uppercase">By Department</div>
          ${(s.byDept||[]).map(x => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bdr);font-size:12px">
            <span style="color:var(--txt2)">${x.dept}</span>
            <span class="td-val">${fmt(x.hrs,1)} hrs</span>
          </div>`).join('') || '<div class="nodata" style="padding:8px 0">No data</div>'}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--txt2);margin-bottom:8px;text-transform:uppercase">Top Reasons</div>
          ${(s.topReasons||[]).slice(0,8).map((x,i) => `<div style="padding:4px 0;border-bottom:1px solid var(--bdr);font-size:12px">
            <span style="color:var(--gold);font-weight:700">${i+1}.</span>
            <span style="color:var(--txt2)"> ${x.reason}</span>
            <span class="td-val" style="float:right">${fmt(x.hrs,1)} hrs</span>
          </div>`).join('') || '<div class="nodata" style="padding:8px 0">No data</div>'}
        </div>
      </div>
    </div>`;
  }

  content.innerHTML = html;
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────

function initAdmin() {
  adminShowPanel(STATE.adminPanel || 'users');
}

function adminShowPanel(panel) {
  STATE.adminPanel = panel;
  document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[id^="admin-panel-"]').forEach(p => { p.style.display = 'none'; });

  const panelEl = document.getElementById('admin-panel-' + panel);
  if (panelEl) panelEl.style.display = '';

  // Activate sidebar button
  document.querySelectorAll('.admin-nav-item').forEach(b => {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes("'" + panel + "'")) {
      b.classList.add('active');
    }
  });

  if (panel === 'users')    loadAdminUsers();
  if (panel === 'limits')   loadAdminLimits();
  if (panel === 'chem-inv') loadChemInventory();
  if (panel === 'import')   loadImportSheets();
}

// ── Import Data ───────────────────────────────────────────────────────────────

async function loadImportSheets() {
  const sel = document.getElementById('import-sheet');
  if (sel.options.length) return; // already loaded
  try {
    const res = await fetch(`/api/import/sheets?token=${encodeURIComponent(STATE.token)}`);
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }
    sel.innerHTML = data.sheets.map(s => `<option value="${s}">${s}</option>`).join('');
  } catch (e) {
    showToast('Failed to load sheet list.');
  }
}

async function doImport() {
  const msg = document.getElementById('import-msg');
  const sheetName = document.getElementById('import-sheet').value;
  const mode = document.getElementById('import-mode').value;
  const fileInput = document.getElementById('import-file');
  const file = fileInput.files[0];

  if (!file) { msg.textContent = 'Please choose a file.'; msg.className = 'form-msg error'; msg.style.display = 'block'; return; }

  msg.textContent = 'Uploading…';
  msg.className = 'form-msg';
  msg.style.display = 'block';

  const formData = new FormData();
  formData.append('file', file);
  formData.append('sheetName', sheetName);
  formData.append('mode', mode);
  formData.append('token', STATE.token);

  try {
    const res = await fetch('/api/import', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) {
      msg.textContent = data.error;
      msg.className = 'form-msg error';
      msg.style.display = 'block';
      return;
    }
    msg.textContent = `Imported ${data.rowsInserted} rows (matched ${data.matchedColumns}/${data.totalColumns} columns).`;
    msg.className = 'form-msg success';
    msg.style.display = 'block';
    fileInput.value = '';
  } catch (e) {
    msg.textContent = 'Upload failed: ' + e.message;
    msg.className = 'form-msg error';
    msg.style.display = 'block';
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function loadAdminUsers() {
  const content = document.getElementById('users-content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  const data = await api('users');
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error'}</div>`;
    return;
  }
  if (!data.length) {
    content.innerHTML = '<div class="nodata">No users found.</div>';
    return;
  }

  content.innerHTML = `<div class="tbl-wrap"><table class="dtbl">
    <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Email</th><th>Active</th><th>Action</th></tr></thead>
    <tbody>${data.map(u => `<tr>
      <td class="td-label">${u.username}</td>
      <td>${u.name}</td>
      <td><span class="role-tag" style="background:var(--gold)">${u.role}</span></td>
      <td style="color:var(--txt3)">${u.email}</td>
      <td>${u.active === 'true' || u.active === '1' || u.active === 'yes'
        ? '<span style="color:var(--ok);font-weight:700">✔ Yes</span>'
        : '<span style="color:var(--crit);font-weight:700">✗ No</span>'}</td>
      <td><button class="save-lim" onclick='openUserModal(${JSON.stringify(u)})'>Edit</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function openUserModal(u) {
  document.getElementById('modal-user-title').textContent = u ? 'Edit User' : 'Add User';
  document.getElementById('usr-username').value  = u ? u.username  : '';
  document.getElementById('usr-name').value      = u ? u.name      : '';
  document.getElementById('usr-role').value      = u ? u.role      : 'process1';
  document.getElementById('usr-email').value     = u ? u.email     : '';
  document.getElementById('usr-password').value  = '';
  document.getElementById('usr-active').value    = u ? (u.active||'true') : 'true';
  document.getElementById('usr-rownum').value    = u ? (u.rowNum || '') : '';
  document.getElementById('usr-msg').style.display = 'none';
  document.getElementById('modal-user').classList.remove('hidden');
}

async function saveUser() {
  const username = document.getElementById('usr-username').value.trim();
  const name     = document.getElementById('usr-name').value.trim();
  const role     = document.getElementById('usr-role').value;
  const email    = document.getElementById('usr-email').value.trim();
  const password = document.getElementById('usr-password').value;
  const active   = document.getElementById('usr-active').value;
  const msg      = document.getElementById('usr-msg');

  if (!username || !role) {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = 'Username and role required.'; return;
  }

  const result = await api('users/save', { username, name, role, email, password: password || undefined, active });
  if (result && result.success) {
    closeModal('user'); showToast('User saved'); loadAdminUsers();
  } else {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = result ? result.error : 'Save failed';
  }
}

// ── Limits ────────────────────────────────────────────────────────────────────

let _limitsData = [];
let _limitsFilter = 'ALL';

async function loadAdminLimits() {
  const content = document.getElementById('limits-content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  const data = await api('limits');
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error'}</div>`;
    return;
  }
  _limitsData = data;
  renderLimitsTable();
}

function renderLimitsTable() {
  const content = document.getElementById('limits-content');
  const data = _limitsData;

  // Collect unique prefixes
  const prefixes = ['ALL'];
  data.forEach(r => {
    const id = String(r['ID'] || '').trim();
    const pf = id.split('_')[0];
    if (pf && !prefixes.includes(pf)) prefixes.push(pf);
  });

  const filtered = _limitsFilter === 'ALL' ? data : data.filter(r => {
    const id = String(r['ID'] || '').trim();
    return id.startsWith(_limitsFilter + '_');
  });

  content.innerHTML = `
    <div class="prefix-btns">
      ${prefixes.map(p => `<button class="prefix-btn ${_limitsFilter === p ? 'active' : ''}" onclick="setLimitsFilter('${p}')">${p}</button>`).join('')}
    </div>
    <div class="tbl-wrap"><table class="dtbl limits-tbl">
      <thead><tr>
        <th>ID</th><th>Label</th><th>Min (Crit)</th><th>Max (Crit)</th>
        <th>Warn Min</th><th>Warn Max</th><th>Unit</th><th>Action</th>
      </tr></thead>
      <tbody>${filtered.map(r => {
        const id = r['ID'] || '';
        return `<tr>
          <td class="td-gold" style="white-space:nowrap">${id}</td>
          <td class="td-label">${r['Label']||''}</td>
          <td><input type="number" id="lim_min_${id}" value="${r['Min']||''}" step="any"></td>
          <td><input type="number" id="lim_max_${id}" value="${r['Max']||''}" step="any"></td>
          <td><input type="number" id="lim_wmin_${id}" value="${r['Warn Min']||''}" step="any"></td>
          <td><input type="number" id="lim_wmax_${id}" value="${r['Warn Max']||''}" step="any"></td>
          <td class="td-unit">${r['Unit']||''}</td>
          <td><button class="save-lim" onclick="saveLimitRow('${id}',${r.rowNum})">Save</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function setLimitsFilter(prefix) {
  _limitsFilter = prefix;
  renderLimitsTable();
}

async function saveLimitRow(id, rowNum) {
  const r = _limitsData.find(x => x['ID'] === id);
  if (!r) return;

  const getVal = (sfx) => {
    const el = document.getElementById(`lim_${sfx}_${id}`);
    return el ? (el.value !== '' ? parseFloat(el.value) : '') : '';
  };

  // Build row array matching headers
  const headers = await api('limits').then(d => {
    if (!d || !d.length) return [];
    return Object.keys(d[0]).filter(k => k !== 'rowNum');
  });

  // Simple approach: patch the values in the _limitsData record
  const updated = { ...r, 'Min': getVal('min'), 'Max': getVal('max'), 'Warn Min': getVal('wmin'), 'Warn Max': getVal('wmax') };
  const rowArray = Object.keys(updated).filter(k => k !== 'rowNum').map(k => updated[k]);

  const result = await api('limits/update', { rowNum, row: rowArray });
  if (result && result.success) {
    showToast(`Limit ${id} updated`);
    // Update local data
    const idx = _limitsData.findIndex(x => x['ID'] === id);
    if (idx >= 0) _limitsData[idx] = { ...updated, rowNum };
  } else {
    showToast(result ? result.error : 'Save failed', 'error');
  }
}

// ── Chemical Inventory ────────────────────────────────────────────────────────

async function loadChemInventory() {
  const content = document.getElementById('chem-inv-content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  const data = await api('chem-inventory');
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error'}</div>`;
    return;
  }
  if (!data.length) {
    content.innerHTML = '<div class="nodata">No chemical inventory data found.</div>';
    return;
  }

  const cols = Object.keys(data[0]).filter(k => k !== 'rowNum');
  content.innerHTML = `<div class="tbl-wrap"><table class="dtbl">
    <thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${data.map(r => `<tr>
      ${cols.map(c => `<td>${r[c] !== undefined ? r[c] : ''}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ── Change Password ────────────────────────────────────────────────────────────

async function doChangePassword() {
  const current  = document.getElementById('pw-current').value;
  const newPw    = document.getElementById('pw-new').value;
  const confirm  = document.getElementById('pw-confirm').value;
  const msg      = document.getElementById('pw-msg');

  msg.style.display = 'none';

  if (!current || !newPw || !confirm) {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = 'All fields are required.'; return;
  }
  if (newPw !== confirm) {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = 'New passwords do not match.'; return;
  }
  if (newPw.length < 6) {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = 'Password must be at least 6 characters.'; return;
  }

  const result = await api('change-password', { currentPassword: current, newPassword: newPw });
  if (result && result.success) {
    msg.className = 'form-msg success'; msg.style.display = 'block';
    msg.textContent = 'Password changed successfully.';
    showToast('Password changed');
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value     = '';
    document.getElementById('pw-confirm').value = '';
  } else {
    msg.className = 'form-msg error'; msg.style.display = 'block';
    msg.textContent = result ? result.error : 'Change failed';
  }
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────

function closeModal(name) {
  const el = document.getElementById('modal-' + name);
  if (el) el.classList.add('hidden');
}

// Close modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});
