/* ═══════════════════════════════════════════════════════════════════
   Plant Monitoring System — Client Application
   Jonnagiri Gold Project · Geomysore
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
const STATE = {
  token: null, role: null, name: null, roleLabel: null,
  filterMode: 'date', filterDate: null, filterMonth: null,
  detailMode: 'date', currentSec: null, currentSubSec: null,
  sectionGroups: {}, groupTabLabels: {}, subSecLabels: {},
  charts: {}, cache: new Map(),
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

// ─── CLIENT-SIDE READ CACHE ─────────────────────────────────────────────────────
// Short-lived cache so flipping between dashboard cards / sections re-renders
// instantly instead of re-fetching + showing skeletons every time. Any write
// action (submit entry, save target/limit, import, etc.) clears it so users
// never see stale data after making a change.
const CACHE_TTL_MS = 45000;

function cacheKey(endpoint, payload) {
  const { token, ...rest } = payload || {};
  return endpoint + '::' + JSON.stringify(rest);
}

function cacheGet(key) {
  const hit = STATE.cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { STATE.cache.delete(key); return null; }
  return hit.data;
}

function cacheSet(key, data) {
  STATE.cache.set(key, { data, ts: Date.now() });
}

function cacheClear() {
  STATE.cache.clear();
}

/**
 * Cache-aware wrapper around api(): returns a cached response instantly if
 * fresh, otherwise fetches, caches, and returns the result.
 */
async function apiCached(endpoint, payload = {}) {
  const key = cacheKey(endpoint, payload);
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await api(endpoint, payload);
  if (data && !data.error) cacheSet(key, data);
  return data;
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
  cacheClear(); // don't leak one user's data into the next login on this tab
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
  const activeKey = STATE.currentSubSec || STATE.currentSec;
  if (!activeKey) { showToast('Open a section first', 'error'); return; }
  const params = new URLSearchParams({ token: STATE.token, section: activeKey });
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

async function loadDashboard(force) {
  const payload = dashFilterPayload();
  const key = cacheKey('dashboard', payload);
  const cached = !force && cacheGet(key);

  if (cached) {
    renderDashboard(cached);
    return;
  }

  const grid = document.getElementById('dash-grid');
  grid.innerHTML = skeletonCards(6);
  document.getElementById('dash-kpis').innerHTML =
    '<div class="kpi-s-tile"><div class="skel-line" style="width:60%"></div><div class="skel-line" style="width:80%;height:9px"></div></div>'.repeat(4);

  const data = await api('dashboard', payload);
  if (!data) return;
  cacheSet(key, data);
  renderDashboard(data);
}

function renderDashboard(data) {
  const grid = document.getElementById('dash-grid');
  document.getElementById('dash-info').textContent = data.date ? 'Showing: ' + data.date : '';
  renderKpiStrip(data.kpis);
  STATE.sectionGroups = data.groups || {};
  STATE.groupTabLabels = data.groupTabLabels || {};

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
      bodyHtml = shown.map(f => {
        // Flags from a grouped sub-sheet (e.g. Slurry Density on the
        // Leaching card) jump straight to that sub-tab when clicked.
        const jumpTo = f.sourceKey && f.sourceKey !== key ? f.sourceKey : '';
        const clickAttr = jumpTo
          ? ` onclick="event.stopPropagation();openSection('${key}','${jumpTo}')" style="cursor:pointer" title="View in ${f.sourceLabel}"`
          : '';
        return `
        <div class="flag-item"${clickAttr}>
          <span class="flag-label">${f.label}${jumpTo ? ` <span style="color:var(--txt3);font-weight:400">(${f.sourceLabel})</span>` : ''}</span>
          <span class="flag-val ${statusClass(f.status)}">${fmt(f.value)} ${f.unit || ''}</span>
        </div>`;
      }).join('') +
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

function openSection(key, subKey) {
  STATE.currentSec    = key;
  STATE.currentSubSec = subKey || key;
  STATE.detailMode    = STATE.filterMode;
  document.getElementById('det-date').value  = document.getElementById('dash-date').value  || STATE.filterDate;
  document.getElementById('det-month').value = document.getElementById('dash-month').value || STATE.filterMonth || '';
  document.getElementById('det-from').value  = document.getElementById('dash-from').value  || '';
  document.getElementById('det-to').value    = document.getElementById('dash-to').value    || '';
  detSetMode(STATE.detailMode);
  showPage('detail');
  loadDetail();
}

// Switches the active sub-tab within a grouped section (e.g. Leaching's
// Slurry Samples / Carbon in Tank / Screen tabs) and reloads that sheet's data.
function switchSubTab(subKey) {
  STATE.currentSubSec = subKey;
  // Cached previous-month overlay data belongs to the old sub-tab's sheet.
  STATE.monthOverlay = false;
  STATE.prevSectionData = null;
  const cb = document.getElementById('det-overlay'); if (cb) cb.checked = false;
  loadDetail();
}

function subTabsHtml() {
  const members = (STATE.sectionGroups || {})[STATE.currentSec];
  if (!members || members.length < 2) return '';
  return `<div class="sub-tabs">${members.map(m =>
    `<button class="sub-tab ${m === STATE.currentSubSec ? 'active' : ''}" onclick="switchSubTab('${m}')">${_subTabLabel(m)}</button>`
  ).join('')}</div>`;
}

// Falls back to the label the last-fetched section data reported for this
// key (data.label), since the client doesn't hold the full section catalog.
function _subTabLabel(key) {
  if ((STATE.groupTabLabels || {})[key]) return STATE.groupTabLabels[key];
  if (STATE.subSecLabels && STATE.subSecLabels[key]) return STATE.subSecLabels[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
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

async function loadDetail(force) {
  const activeKey = STATE.currentSubSec || STATE.currentSec;
  const payload = { section: activeKey, ...detFilterPayload() };
  const key = cacheKey('section', payload);
  const cached = !force && cacheGet(key);

  if (cached) {
    renderDetailData(activeKey, cached);
    return;
  }

  const content = document.getElementById('det-content');
  content.innerHTML = `
    <div class="skel-card" style="height:90px"><div class="skel-line" style="width:40%"></div><div class="skel-line" style="width:65%"></div></div>
    <div class="skel-card" style="height:220px;margin-top:14px"><div class="skel-line" style="width:30%"></div><div class="skel-line" style="width:90%;height:140px"></div></div>`;

  const data = await api('section', payload);
  if (!data || data.error) {
    content.innerHTML = `${subTabsHtml()}<div class="nodata">${data ? data.error : 'Error loading data'}</div>`;
    return;
  }
  cacheSet(key, data);
  renderDetailData(activeKey, data);
}

function renderDetailData(activeKey, data) {
  const content = document.getElementById('det-content');

  // Destroy old charts
  Object.values(STATE.charts).forEach(c => { try { c && c.destroy && c.destroy(); } catch (e) {} });
  STATE.charts = {};

  // Remember this sub-tab's real label so the tab bar can show it even
  // before its data has ever been fetched in this session.
  STATE.subSecLabels = STATE.subSecLabels || {};
  STATE.subSecLabels[activeKey] = data.label;

  const isGrouped = (STATE.sectionGroups || {})[STATE.currentSec] && STATE.sectionGroups[STATE.currentSec].length > 1;
  document.getElementById('det-title').textContent = isGrouped ? (STATE.subSecLabels[STATE.currentSec] || data.label) : data.label;
  const modeLbl = STATE.detailMode === 'date' ? 'Date: ' : STATE.detailMode === 'month' ? 'Month: ' : 'Range: ';
  document.getElementById('det-sub').textContent   = (isGrouped ? data.label + ' · ' : '') + modeLbl + (data.date || '');
  STATE.lastSectionData = data;

  if (!data.hasData) {
    content.innerHTML = `${subTabsHtml()}<div class="nodata">No data for this period.</div>`;
    return;
  }

  // Leaching keeps its own tank-specific visualizations (heatmap, tank
  // profile, all-tanks trend); every other section gets the single
  // customizable Production Trend chart. Target progress (when set) shows
  // inline as one of the KPI tiles — see kpiTargetTileHtml.
  const showProdTrend = activeKey !== 'leaching';
  content.innerHTML = subTabsHtml() + renderSection(data);

  if (showProdTrend) {
    // Insert right after the KPI row (or right after the sub-tabs/heatmap
    // area if a section has no KPI row) so it sits near the top, above
    // tables/stoppages/chemical strips — not buried at the bottom.
    const kpiRow = content.querySelector('.kpi-row-1, .kpi-row-2, .kpi-row-3');
    const anchor = kpiRow || content.querySelector('.sub-tabs') || content.firstElementChild;
    const trendHtml = productionTrendBlockHtml();
    if (anchor) anchor.insertAdjacentHTML('afterend', trendHtml);
    else content.insertAdjacentHTML('afterbegin', trendHtml);
  }

  // Build charts after DOM settles
  setTimeout(() => {
    buildSectionCharts(data);
    buildTargetGauges(data);
    if (showProdTrend) buildProductionTrendChart(activeKey, data);
  }, 60);
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

  // Production's tile becomes a gauge tile in place, when a target is set —
  // same row, same slot, just richer content.
  const prodTile = kpiTargetTileHtml('Production', data);

  return `
    <div class="kpi-row-3">
      <div class="kpi-tile">
        <div class="kpi-label">Running Hours</div>
        <div class="kpi-val">${fmt(totalHrs,1)}</div>
        <div class="kpi-unit">hrs</div>
      </div>
      ${prodTile || `
      <div class="kpi-tile">
        <div class="kpi-label">Production</div>
        <div class="kpi-val gold">${fmt(totalProd,0)}</div>
        <div class="kpi-unit">tonnes</div>
      </div>`}
      <div class="kpi-tile">
        <div class="kpi-label">Avg TPH</div>
        <div class="kpi-val">${fmt(avgTph,1)}</div>
        <div class="kpi-unit">t/hr</div>
      </div>
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
  const prodTile = kpiTargetTileHtml('Production', data);

  return `
    <div class="kpi-row-3">
      <div class="kpi-tile">
        <div class="kpi-label">Running Hours</div>
        <div class="kpi-val">${fmt(totalHrs,1)}</div>
        <div class="kpi-unit">hrs</div>
      </div>
      ${prodTile || `
      <div class="kpi-tile">
        <div class="kpi-label">Production</div>
        <div class="kpi-val gold">${fmt(totalProd,0)}</div>
        <div class="kpi-unit">tonnes</div>
      </div>`}
      <div class="kpi-tile">
        <div class="kpi-label">Avg Feed Grade</div>
        <div class="kpi-val">${fmt(avgFG,2)}</div>
        <div class="kpi-unit">g/t</div>
      </div>
    </div>
    ${chemStrip(data.chemicals)}
    ${stoppagesHtml(data.stoppages)}
    ${genericTableHtml(data)}`;
}

// ── Leaching ──────────────────────────────────────────────────────────────────
function renderLeaching(data) {
  const leachParam = STATE.leachHmParam || 'nacn';
  return `
    <div class="section-block">
      <div class="section-block-title">Leaching Tank Heatmap</div>
      <div class="param-sel-btns">
        <button class="param-sel-btn ${leachParam==='nacn'?'active':''}" id="lhm-btn-nacn" onclick="switchLeachParam('nacn')">NaCN (ppm)</button>
        <button class="param-sel-btn ${leachParam==='ph'?'active':''}" id="lhm-btn-ph"   onclick="switchLeachParam('ph')">pH</button>
        <button class="param-sel-btn ${leachParam==='au'?'active':''}" id="lhm-btn-au"   onclick="switchLeachParam('au')">Au in Liquor</button>
        <button class="param-sel-btn ${leachParam==='do'?'active':''}" id="lhm-btn-do"   onclick="switchLeachParam('do')">DO (ppm)</button>
      </div>
      <div id="leach-heatmap-wrap">${renderLeachingHeatmap(data, leachParam)}</div>
    </div>
    <div class="section-block">
      <div class="section-block-title">Tank Profile — Latest Reading</div>
      <div class="chart-canvas-wrap" style="height:220px"><canvas id="chart-leach-tankprofile"></canvas></div>
      <div class="chart-canvas-wrap" id="leach-tankprofile-dt-wrap" style="height:160px;margin-top:8px"><canvas id="chart-leach-tankprofile-dt"></canvas></div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title" id="chart-leach-main-title">Leaching Trend — All Tanks</div>
      <div class="chart-canvas-wrap" style="height:280px"><canvas id="chart-leach-main"></canvas></div>
    </div>
    ${stoppagesHtml(data.stoppages)}`;
}

window._leachData = null;
function switchLeachParam(param) {
  STATE.leachHmParam = param;
  document.querySelectorAll('.param-sel-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('lhm-btn-' + param);
  if (btn) btn.classList.add('active');
  if (window._leachData) {
    document.getElementById('leach-heatmap-wrap').innerHTML = renderLeachingHeatmap(window._leachData, param);
    buildLeachTankProfile(window._leachData, param);
    buildLeachMultiTankChart(window._leachData, param);
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
    ${latest ? `<div class="section-block">
      <div class="section-block-title">Carbon Profile — All Tanks</div>
      <div class="chart-canvas-wrap" style="height:220px"><canvas id="chart-carbon-profile"></canvas></div>
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

  const auTile = kpiTargetTileHtml('Au Content (g)', data);

  return `
    <div class="kpi-row-2">
      <div class="kpi-tile" style="--kpi-color:var(--gold)">
        <div class="kpi-label">Total Dore Mass</div>
        <div class="kpi-val gold">${fmt(totalMass,1)}</div>
        <div class="kpi-unit">g</div>
      </div>
      ${auTile || `
      <div class="kpi-tile" style="--kpi-color:var(--gold)">
        <div class="kpi-label">Total Au Content</div>
        <div class="kpi-val gold">${fmt(totalAu,1)}</div>
        <div class="kpi-unit">g</div>
      </div>`}
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

/**
 * A flat dashed gold line representing a target value, drawn behind the
 * actual data so it reads as a reference line rather than a series.
 */
/**
 * Bar chart of a single parameter's latest value across a set of tanks —
 * a compact "leach train health" snapshot for the current moment.
 */
function buildTankProfileChart(canvasId, latestRow, tanks, keyFn, label, lim) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !latestRow) return;
  const vals = tanks.map(t => { const v = parseFloat(latestRow[keyFn(t)]); return isNaN(v) ? null : v; });
  buildChart(canvasId, tanks, [
    { label, data: vals, backgroundColor: 'rgba(184,134,11,.65)', type: 'bar' },
    ...limitBandDatasets(lim, tanks),
  ], {}, { noZoom: true });
}

/**
 * opts.onPointClick(label, index) — called when a data point is clicked;
 * used to drill from a month/range trend chart into that specific date.
 * opts.noZoom — disable pan/zoom for charts where it doesn't make sense
 * (e.g. tank-profile bars with categorical, not sequential, x-axis).
 */
function buildChart(canvasId, labels, datasets, scales = {}, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (STATE.charts[canvasId]) {
    try { STATE.charts[canvasId].destroy(); } catch (e) {}
    delete STATE.charts[canvasId];
  }
  if (typeof Chart === 'undefined') return;

  const hasZoomPlugin = typeof Chart !== 'undefined' && Chart.registry && Chart.registry.plugins.get('zoom');
  const zoomConfig = (!opts.noZoom && hasZoomPlugin) ? {
    pan:  { enabled: true, mode: 'x', modifierKey: null },
    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
  } : undefined;

  STATE.charts[canvasId] = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (evt, elements, chart) => {
        if (!opts.onPointClick || !elements.length) return;
        const idx = elements[0].index;
        opts.onPointClick(chart.data.labels[idx], idx);
      },
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { boxWidth: 12, font: { size: 10 }, filter: item => item.text !== '__band__' },
        },
        tooltip: { filter: item => item.dataset.label !== '__band__' },
        ...(zoomConfig ? { zoom: zoomConfig } : {}),
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

// ─── PRODUCTION TREND: ONE customizable multi-series chart per section ────────
// Instead of one chart per parameter, each section gets a single "Production
// Trend" chart. Users add/remove parameters as series on THAT chart, each
// with its own type (Bar/Line/Area/Scatter); series sharing a unit share a
// Y-axis, series with different units get their own. Persisted per section.

// Numeric, chartable parameters for a section (excludes text/time/select —
// autoCalc fields like TPH are included since they're still numeric).
function _chartableParams(data) {
  return (data.params || []).filter(p => !p.isText && !p.isTime && !p.isSelect);
}

function _trendSeriesKey(sectionKey) {
  return 'trendSeries:' + sectionKey;
}

function loadTrendSeries(sectionKey, data) {
  try {
    const raw = localStorage.getItem(_trendSeriesKey(sectionKey));
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to default */ }

  // First-ever visit to this section: default to Production as a bar chart
  // (or the first chartable parameter if there's no literal "Production").
  const chartable = _chartableParams(data);
  const prod = chartable.find(p => p.key === 'Production') || chartable[0];
  return prod ? [{ id: 'default', paramKey: prod.key, type: 'bar', color: TREND_PALETTE[0] }] : [];
}

function saveTrendSeries(sectionKey, series) {
  try { localStorage.setItem(_trendSeriesKey(sectionKey), JSON.stringify(series)); } catch (e) { /* storage unavailable */ }
}

// ─── TARGET PROGRESS (Ahead / On Track / Behind, gauge + bar + variance) ──────

// hexColor is a real canvas-usable color (CSS custom properties can't be used
// as canvas fillStyle directly); cssColor is for HTML/inline-style contexts.
// Colors follow the requested rule: green = on/above target, yellow = 80-99%
// of expected, red = below 80% of expected.
const TARGET_STATUS_META = {
  ON_TARGET: { hexColor: '#1A7A4A' },
  WARNING:   { hexColor: '#B45309' },
  BEHIND:    { hexColor: '#B91C1C' },
  NO_DATA:   { hexColor: '#888580' },
};

/**
 * Renders a single targeted parameter as a normal-sized KPI tile (same
 * grid slot as Running Hours/TPH, not a separate full-width block):
 * label + cumulative + unit at top, a small gauge with % in the middle,
 * and — month view only — Monthly Target / Current Rate / Required Rate
 * stacked directly below the gauge.
 */
function kpiTargetTileHtml(paramKey, data) {
  const tp = (data.targetProgress || {})[paramKey];
  if (!tp) return null;

  const paramsByKey = {};
  (data.params || []).forEach(p => { paramsByKey[p.key] = p; });
  const p = paramsByKey[paramKey] || { label: paramKey, unit: '' };
  const safe = paramKey.replace(/[^a-zA-Z0-9]/g, '_');
  const unit = p.unit || '';
  const isMonth = tp.mode === 'month';

  const rangeMax = isMonth ? tp.monthlyTarget : tp.target;

  return `
    <div class="kpi-tile kpi-target-tile${isMonth ? '' : ' kpi-target-tile-daily'}">
      <div class="kpi-target-col kpi-target-col-info">
        <div class="kpi-label">${p.label.toUpperCase()}</div>
        <div class="kpi-val gold">${fmt(tp.actual,0)}</div>
        <div class="kpi-unit">${unit}</div>
      </div>
      <div class="kpi-target-col kpi-target-col-gauge">
        <div class="target-gauge-wrap-sm">
          <canvas id="chart-target-gauge-${safe}"></canvas>
          <div class="target-gauge-pct-sm">${fmt(tp.pctAchieved,0)}%</div>
        </div>
        <div class="target-gauge-range">
          <span>0</span>
          <span>${fmt(rangeMax,0)} ${unit}</span>
        </div>
      </div>
      ${isMonth ? `
      <div class="kpi-target-col kpi-target-col-rates">
        <div class="kpi-target-substat">
          <span class="kpi-target-substat-icon rate">&#8635;</span>
          <span class="kpi-target-substat-txt"><span class="kpi-target-substat-lbl">Current Rate</span><span class="kpi-target-substat-val">${fmt(tp.currentRate,0)} ${unit}/day</span></span>
        </div>
        <div class="kpi-target-substat">
          <span class="kpi-target-substat-icon req">&#8599;</span>
          <span class="kpi-target-substat-txt"><span class="kpi-target-substat-lbl">Required Rate</span><span class="kpi-target-substat-val">${tp.requiredRate !== null ? fmt(tp.requiredRate,0) + ' ' + unit + '/day' : '—'}</span></span>
        </div>
      </div>` : ''}
    </div>`;
}

function buildTargetGauges(data) {
  const progress = data.targetProgress || {};
  Object.keys(progress).forEach(paramKey => {
    const tp = progress[paramKey];
    const safe = paramKey.replace(/[^a-zA-Z0-9]/g, '_');
    const canvasId = 'chart-target-gauge-' + safe;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (STATE.charts[canvasId]) { try { STATE.charts[canvasId].destroy(); } catch (e) {} delete STATE.charts[canvasId]; }
    if (typeof Chart === 'undefined') return;

    const meta = TARGET_STATUS_META[tp.status] || TARGET_STATUS_META.ON_TARGET;
    const achieved = Math.max(0, Math.min(100, tp.pctAchieved));

    STATE.charts[canvasId] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Achieved', 'Remaining'],
        datasets: [{ data: [achieved, 100 - achieved], backgroundColor: [meta.hexColor, 'rgba(0,0,0,.08)'], borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        circumference: 180, rotation: 270, cutout: '72%',
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
  });
}

function productionTrendBlockHtml() {
  return `
    <div class="chart-wrap">
      <div class="chart-title-row" style="display:flex;justify-content:space-between;align-items:center">
        <div class="chart-title">Production Trend</div>
        <button class="chart-gear-btn" onclick="openTrendSeriesManager()" title="Add or edit chart parameters">⚙</button>
      </div>
      <div class="chart-canvas-wrap" style="height:320px"><canvas id="chart-prod-trend"></canvas></div>
    </div>`;
}

const TREND_PALETTE = ['#7B1E2E','#B8860B','#2471A3','#1A7A4A','#7D3C98','#C0392B','#D35400','#16A085'];

function buildProductionTrendChart(sectionKey, data) {
  const canvasId = 'chart-prod-trend';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (STATE.charts[canvasId]) {
    try { STATE.charts[canvasId].destroy(); } catch (e) {}
    delete STATE.charts[canvasId];
  }

  const series = loadTrendSeries(sectionKey, data);
  if (!series.length || typeof Chart === 'undefined') return;

  const isMonth = data.isAggregate || STATE.detailMode !== 'date';
  const rows = isMonth ? (data.dailyRows && data.dailyRows.length ? data.dailyRows : data.rows) : data.rows;
  const labels = rows.map(r => r.__date || r.__time || '');
  const paramsByKey = {};
  _chartableParams(data).forEach(p => { paramsByKey[p.key] = p; });

  // Assign a Y-axis per unique unit so parameters with different units (e.g.
  // tonnes vs t/hr) each get their own scale instead of being squashed together.
  const unitToAxis = {};
  const datasets = [];
  series.forEach((s, i) => {
    const p = paramsByKey[s.paramKey];
    if (!p) return;
    const unit = p.unit || '—';
    if (!(unit in unitToAxis)) unitToAxis[unit] = 'y' + Object.keys(unitToAxis).length;
    const axisId = unitToAxis[unit];
    const color = s.color || TREND_PALETTE[i % TREND_PALETTE.length];
    const values = rows.map(r => { const v = parseFloat(r[s.paramKey]); return isNaN(v) ? null : v; });
    const label = p.label + (p.unit ? ` (${p.unit})` : '');

    if (s.type === 'bar') {
      datasets.push({ type: 'bar', label, data: values, backgroundColor: color + 'A6', yAxisID: axisId });
    } else if (s.type === 'area') {
      datasets.push({ type: 'line', label, data: values, borderColor: color, backgroundColor: color + '26', fill: true, tension: .3, pointRadius: 2, yAxisID: axisId });
    } else if (s.type === 'scatter') {
      datasets.push({ type: 'line', label, data: values, borderColor: color, backgroundColor: color, showLine: false, pointRadius: 5, yAxisID: axisId });
    } else {
      datasets.push({ type: 'line', label, data: values, borderColor: color, backgroundColor: 'transparent', fill: false, tension: .3, pointRadius: 2, yAxisID: axisId });
    }
  });

  const scales = { x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } } };
  Object.entries(unitToAxis).forEach(([unit, axisId], i) => {
    scales[axisId] = {
      position: i % 2 === 0 ? 'left' : 'right',
      beginAtZero: false,
      grid: { display: i === 0, color: 'rgba(0,0,0,.05)' },
      ticks: { font: { size: 10 } },
      title: { display: unit !== '—', text: unit === '—' ? '' : unit },
    };
  });

  STATE.charts[canvasId] = new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
      scales,
      onClick: (evt, elements, chart) => {
        if (!elements.length) return;
        const handler = _drillClickHandler(data, isMonth);
        if (handler) handler(chart.data.labels[elements[0].index]);
      },
    },
  });
}

function openTrendSeriesManager() {
  const data = STATE.lastSectionData;
  const sectionKey = STATE.currentSubSec || STATE.currentSec;
  if (!data) { showToast('Open a section first', 'error'); return; }

  const chartable = _chartableParams(data);
  const paramsByKey = {};
  chartable.forEach(p => { paramsByKey[p.key] = p; });

  STATE._trendSectionKey = sectionKey;
  _renderTrendSeriesList(sectionKey, paramsByKey);
  document.getElementById('modal-chart-customize').classList.remove('hidden');
}

function _renderTrendSeriesList(sectionKey, paramsByKey) {
  const series = loadTrendSeries(sectionKey, STATE.lastSectionData);
  const list = document.getElementById('cc-series-list');

  list.innerHTML = series.length ? series.map((s, i) => {
    const p = paramsByKey[s.paramKey];
    if (!p) return '';
    const color = s.color || TREND_PALETTE[i % TREND_PALETTE.length];
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bdr)">
        <input type="color" value="${color}" title="Chart color" style="width:28px;height:28px;padding:0;border:1px solid var(--bdr);border-radius:4px;cursor:pointer;flex-shrink:0" onchange="changeTrendSeriesColor('${s.id}', this.value)">
        <span style="flex:1;font-size:13px">${p.label}${p.unit ? ` <span style="color:var(--txt3);font-size:11px">(${p.unit})</span>` : ''}</span>
        <select class="filter-input" onchange="changeTrendSeriesType('${s.id}', this.value)">
          <option value="bar"     ${s.type==='bar'?'selected':''}>Bar</option>
          <option value="line"    ${s.type==='line'?'selected':''}>Line</option>
          <option value="area"    ${s.type==='area'?'selected':''}>Area</option>
          <option value="scatter" ${s.type==='scatter'?'selected':''}>Scatter</option>
        </select>
        <button class="btn-cancel" onclick="removeTrendSeries('${s.id}')" style="padding:3px 9px;color:var(--crit);border-color:var(--crit-bdr)">✕</button>
      </div>`;
  }).join('') : '<div class="nodata" style="padding:12px 0">No parameters on this chart yet.</div>';

  const usedKeys = new Set(series.map(s => s.paramKey));
  const available = Object.values(paramsByKey).filter(p => !usedKeys.has(p.key));
  const addSel = document.getElementById('cc-add-param');
  const addBtn = document.getElementById('cc-add-btn');
  if (available.length) {
    addSel.disabled = false; addBtn.disabled = false;
    addSel.innerHTML = available.map(p => `<option value="${p.key}">${p.label}${p.unit ? ` (${p.unit})` : ''}</option>`).join('');
  } else {
    addSel.disabled = true; addBtn.disabled = true;
    addSel.innerHTML = '<option>All parameters added</option>';
  }
  document.getElementById('cc-add-color').value = TREND_PALETTE[series.length % TREND_PALETTE.length];
}

function addTrendSeries() {
  const sectionKey = STATE._trendSectionKey;
  const data = STATE.lastSectionData;
  const paramKey = document.getElementById('cc-add-param').value;
  const type = document.getElementById('cc-add-type').value;
  const color = document.getElementById('cc-add-color').value;
  if (!paramKey) return;

  const series = loadTrendSeries(sectionKey, data);
  series.push({ id: 'series_' + Date.now(), paramKey, type, color });
  saveTrendSeries(sectionKey, series);

  const paramsByKey = {};
  _chartableParams(data).forEach(p => { paramsByKey[p.key] = p; });
  _renderTrendSeriesList(sectionKey, paramsByKey);
  buildProductionTrendChart(sectionKey, data);
}

function changeTrendSeriesType(seriesId, type) {
  const sectionKey = STATE._trendSectionKey;
  const data = STATE.lastSectionData;
  const series = loadTrendSeries(sectionKey, data);
  const s = series.find(x => x.id === seriesId);
  if (s) s.type = type;
  saveTrendSeries(sectionKey, series);
  buildProductionTrendChart(sectionKey, data);
}

function changeTrendSeriesColor(seriesId, color) {
  const sectionKey = STATE._trendSectionKey;
  const data = STATE.lastSectionData;
  const series = loadTrendSeries(sectionKey, data);
  const s = series.find(x => x.id === seriesId);
  if (s) s.color = color;
  saveTrendSeries(sectionKey, series);
  buildProductionTrendChart(sectionKey, data);
}

function removeTrendSeries(seriesId) {
  const sectionKey = STATE._trendSectionKey;
  const data = STATE.lastSectionData;
  const series = loadTrendSeries(sectionKey, data).filter(s => s.id !== seriesId);
  saveTrendSeries(sectionKey, series);

  const paramsByKey = {};
  _chartableParams(data).forEach(p => { paramsByKey[p.key] = p; });
  _renderTrendSeriesList(sectionKey, paramsByKey);
  buildProductionTrendChart(sectionKey, data);
}

function buildSectionCharts(data) {
  const key   = data.section;
  const isMonth = data.isAggregate || STATE.detailMode !== 'date';
  const rows  = isMonth ? (data.dailyRows && data.dailyRows.length ? data.dailyRows : data.rows) : data.rows;
  if (!rows.length) return;

  window._leachData = data; // store for param switching

  const labels = rows.map(r => r.__date || r.__time || '');

  if (key === 'leaching') {
    const param = STATE.leachHmParam || 'nacn';
    buildLeachMultiTankChart(data, param);
    buildLeachTankProfile(data, param);
  }

  if (key === 'carbon') {
    buildCarbonTankProfile(data);
  }
}

// Extracts a 'YYYY-MM-DD' date string's day-of-month as a number, or null.
function dayOfMonth(dateStr) {
  const d = parseInt(String(dateStr || '').slice(8, 10), 10);
  return isNaN(d) ? null : d;
}

/**
 * Click handler for month/range trend charts: navigates section detail to
 * the exact date clicked.
 */
function _drillClickHandler(data, isMonth) {
  if (!isMonth) return undefined;
  return (label) => {
    if (!label) return;
    document.getElementById('det-date').value = label;
    detSetMode('date');
    loadDetail();
  };
}

const LEACH_LT_TANKS = ['LT4','LT5','LT6','LT7','LT8','LT9','LT10'];
const LEACH_DT_TANKS = ['DT1','DT4'];

const LEACH_TANK_COLORS = {
  LT4: '#C0392B', LT5: '#2471A3', LT6: '#1A7A4A', LT7: '#B7950B',
  LT8: '#7D3C98', LT9: '#D35400', LT10: '#16A085',
};

// Plots every leach tank's chosen parameter (NaCN/pH/Au/DO — same selector
// as the heatmap) as one colored line each, so all tanks compare at a
// glance instead of viewing one tank at a time via a dropdown.
function buildLeachMultiTankChart(data, param) {
  const isMonth = data.isAggregate || STATE.detailMode !== 'date';
  const rows = isMonth ? (data.dailyRows && data.dailyRows.length ? data.dailyRows : data.rows) : data.rows;
  if (!rows || !rows.length) return;

  const paramKeyMap = {
    nacn: t => `${t} NaCN (ppm)`, ph: t => `${t} pH`,
    au:   t => `${t} Au in Liquor (ppm)`, do: t => `${t} DO (ppm)`,
  };
  const keyFn = paramKeyMap[param] || paramKeyMap.nacn;
  const btnEl = document.getElementById('lhm-btn-' + param);
  const paramLabel = btnEl ? btnEl.textContent : param;

  const labels = rows.map(r => r.__date || r.__time || '');
  const datasets = LEACH_LT_TANKS.map(tank => ({
    label: tank,
    data: rows.map(r => { const v = parseFloat(r[keyFn(tank)]); return isNaN(v) ? null : v; }),
    borderColor: LEACH_TANK_COLORS[tank] || '#888',
    backgroundColor: 'transparent',
    fill: false, tension: .3, pointRadius: 2, borderWidth: 1.75,
  }));

  const titleEl = document.getElementById('chart-leach-main-title');
  if (titleEl) titleEl.textContent = `Leaching Trend — All Tanks (${paramLabel})`;

  buildChart('chart-leach-main', labels, datasets, {}, {
    onPointClick: _drillClickHandler(data, isMonth),
  });
}

// Bar chart of every leach/discharge tank's latest reading for the currently
// selected heatmap parameter — a compact "leach train health" snapshot.
function buildLeachTankProfile(data, param) {
  const rows = data.rows || [];
  const latest = rows[rows.length - 1];
  if (!latest) return;

  const paramKeyMap = {
    nacn: t => `${t} NaCN (ppm)`, ph: t => `${t} pH`,
    au:   t => `${t} Au in Liquor (ppm)`, do: t => `${t} DO (ppm)`,
  };
  const dtKeyMap = {
    nacn: t => `${t} CN (ppm)`, ph: t => `${t} pH`, au: t => `${t} Au in Liquor (ppm)`,
  };
  const btnLabel = document.querySelector(`#lhm-btn-${param}`) ? document.querySelector(`#lhm-btn-${param}`).textContent : param;
  const keyFn = paramKeyMap[param] || paramKeyMap.nacn;
  buildTankProfileChart('chart-leach-tankprofile', latest, LEACH_LT_TANKS, keyFn, btnLabel);

  // DT tanks only make sense for nacn(→CN)/au/ph, same as the heatmap logic
  const dtWrap = document.getElementById('leach-tankprofile-dt-wrap');
  if (dtKeyMap[param]) {
    if (dtWrap) dtWrap.style.display = '';
    buildTankProfileChart('chart-leach-tankprofile-dt', latest, LEACH_DT_TANKS, dtKeyMap[param], btnLabel);
  } else {
    if (dtWrap) dtWrap.style.display = 'none';
    if (STATE.charts['chart-leach-tankprofile-dt']) {
      try { STATE.charts['chart-leach-tankprofile-dt'].destroy(); } catch (e) {}
      delete STATE.charts['chart-leach-tankprofile-dt'];
    }
  }
}

const CARBON_TANKS_LIST = ['LT4','LT5','LT6','LT7','LT8','LT9','LT10'];

function buildCarbonTankProfile(data) {
  const rows = data.rows || [];
  const latest = rows[rows.length - 1];
  if (!latest) return;
  buildTankProfileChart('chart-carbon-profile', latest, CARBON_TANKS_LIST, t => `${t} Carbon (g/L)`, 'Carbon (g/L)');
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
    cacheClear();
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
        <thead><tr><th>Parameter</th><th>Unit</th><th>Target</th><th>Notes</th><th>Set By</th><th>Action</th></tr></thead>
        <tbody>${byMonth[m].map(t => `<tr>
          <td class="td-label">${t.param || t.paramId}</td>
          <td class="td-unit">${t.unit}</td>
          <td style="color:var(--maroon);font-weight:700;font-family:var(--mono)">${fmt(t.target,2)}</td>
          <td>${t.notes||''}</td>
          <td style="color:var(--txt3);font-size:11px">${t.setBy||''}</td>
          <td><button class="save-lim" onclick='editTarget(${JSON.stringify(t)})'>Edit</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('');
}

// Section/parameter catalog for dropdowns — fetched once per session
async function getParamCatalog() {
  if (STATE.paramCatalog) return STATE.paramCatalog;
  const data = await api('params-catalog');
  if (data && data.sections) STATE.paramCatalog = data.sections;
  return STATE.paramCatalog || [];
}

async function populateTargetSelectors(selSection, selParam) {
  const sections = await getParamCatalog();
  const secSel = document.getElementById('tgt-section');
  secSel.innerHTML = '<option value="">— Select section —</option>' +
    sections.map(s => `<option value="${s.key}">${s.label}</option>`).join('') +
    '<option value="__custom__">Custom (enter manually)</option>';
  if (selSection) secSel.value = selSection;
  tgtSectionChanged(selParam);
}

function tgtSectionChanged(selParam) {
  const secKey = document.getElementById('tgt-section').value;
  const custom = secKey === '__custom__';
  document.getElementById('tgt-custom-rows').style.display  = custom ? '' : 'none';
  document.getElementById('tgt-paramkey-row').style.display = custom || !secKey ? 'none' : '';
  if (custom || !secKey) { document.getElementById('tgt-unit-hint').textContent = ''; return; }

  const section = (STATE.paramCatalog || []).find(s => s.key === secKey);
  const paramSel = document.getElementById('tgt-paramkey');
  paramSel.innerHTML = (section ? section.params : [])
    .map(p => `<option value="${p.key}" data-unit="${p.unit}">${p.key}</option>`).join('');
  if (selParam) paramSel.value = selParam;
  tgtParamChanged();
}

function tgtParamChanged() {
  const sel = document.getElementById('tgt-paramkey');
  const unit = sel.selectedOptions[0] ? sel.selectedOptions[0].getAttribute('data-unit') : '';
  document.getElementById('tgt-unit-hint').textContent = unit ? `· unit: ${unit}` : '';
}

function openTargetModal() {
  document.getElementById('modal-target-title').textContent = 'Add Target';
  document.getElementById('tgt-month').value    = STATE.filterMonth || '';
  document.getElementById('tgt-param-id').value = '';
  document.getElementById('tgt-param').value    = '';
  document.getElementById('tgt-unit').value     = '';
  document.getElementById('tgt-value').value    = '';
  document.getElementById('tgt-notes').value    = '';
  document.getElementById('tgt-rownum').value   = '';
  document.getElementById('tgt-msg').style.display = 'none';
  populateTargetSelectors();
  document.getElementById('modal-target').classList.remove('hidden');
}

async function editTarget(t) {
  document.getElementById('modal-target-title').textContent = 'Edit Target';
  document.getElementById('tgt-month').value    = t.month || '';
  document.getElementById('tgt-value').value    = t.target || '';
  document.getElementById('tgt-notes').value    = t.notes  || '';
  document.getElementById('tgt-rownum').value   = t.rowNum || '';
  document.getElementById('tgt-msg').style.display = 'none';

  // Catalog-style IDs look like "sectionKey:Param Key" — preselect dropdowns;
  // anything else opens in custom mode so legacy targets stay editable.
  const m = String(t.paramId || '').match(/^([a-z0-9]+):(.+)$/i);
  await populateTargetSelectors();
  const sections = STATE.paramCatalog || [];
  if (m && sections.some(s => s.key === m[1] && s.params.some(p => p.key === m[2]))) {
    document.getElementById('tgt-section').value = m[1];
    tgtSectionChanged(m[2]);
  } else {
    document.getElementById('tgt-section').value = '__custom__';
    tgtSectionChanged();
    document.getElementById('tgt-param-id').value = t.paramId || '';
    document.getElementById('tgt-param').value    = t.param  || '';
    document.getElementById('tgt-unit').value     = t.unit   || '';
  }
  document.getElementById('modal-target').classList.remove('hidden');
}

async function saveTarget() {
  const month   = document.getElementById('tgt-month').value;
  const secKey  = document.getElementById('tgt-section').value;
  const target  = parseFloat(document.getElementById('tgt-value').value);
  const notes   = document.getElementById('tgt-notes').value.trim();
  const rowNum  = document.getElementById('tgt-rownum').value;
  const msg     = document.getElementById('tgt-msg');

  const fail = (text) => {
    msg.className = 'form-msg error'; msg.style.display = 'block'; msg.textContent = text;
  };
  if (!month) return fail('Month is required.');

  const payload = { month, target: isNaN(target) ? 0 : target, notes, rowNum: rowNum || null };
  if (secKey && secKey !== '__custom__') {
    const paramKey = document.getElementById('tgt-paramkey').value;
    if (!paramKey) return fail('Select a parameter.');
    payload.section = secKey;
    payload.paramKey = paramKey;
  } else {
    payload.paramId = document.getElementById('tgt-param-id').value.trim();
    payload.param   = document.getElementById('tgt-param').value.trim();
    payload.unit    = document.getElementById('tgt-unit').value.trim();
    if (!payload.paramId) return fail(secKey ? 'Enter a custom Param ID.' : 'Select a section.');
  }

  const result = await api('targets/save', payload);
  if (result && result.success) {
    cacheClear(); // target lines on section charts must reflect the new value
    closeModal('target'); showToast('Target saved'); loadTargets();
  } else {
    fail(result ? result.error : 'Save failed');
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
      ${(s.topReasons||[]).length ? `
      <div style="margin-top:16px">
        <div style="font-size:11px;font-weight:700;color:var(--txt2);margin-bottom:8px;text-transform:uppercase">Downtime Pareto</div>
        <div class="chart-canvas-wrap" style="height:240px"><canvas id="chart-report-pareto"></canvas></div>
      </div>` : ''}
    </div>`;
  }

  content.innerHTML = html;
  if (data.stoppages && (data.stoppages.topReasons || []).length) {
    setTimeout(() => buildParetoChart(data.stoppages.topReasons), 60);
  }
}

// Classic Pareto: reasons ranked by hours (bars) with a cumulative-%
// line on a secondary axis — highlights the "vital few" causes.
function buildParetoChart(topReasons) {
  const labels = topReasons.map(r => r.reason);
  const hrs = topReasons.map(r => r.hrs);
  const total = hrs.reduce((a, b) => a + b, 0) || 1;
  let running = 0;
  const cumPct = hrs.map(h => { running += h; return +((running / total) * 100).toFixed(1); });

  buildChart('chart-report-pareto', labels, [
    { label: 'Hours', data: hrs, backgroundColor: 'rgba(123,30,46,.65)', type: 'bar', yAxisID: 'y' },
    { label: 'Cumulative %', data: cumPct, borderColor: '#B8860B', backgroundColor: 'transparent', type: 'line', yAxisID: 'y2', tension: .2, pointRadius: 3 },
  ], {
    y:  { title: { display: true, text: 'hrs' } },
    y2: { title: { display: true, text: '%' }, min: 0, max: 100 },
  }, { noZoom: true });
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
    cacheClear();
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

  const data = await api('limits/catalog');
  if (!data || data.error) {
    content.innerHTML = `<div class="nodata">${data ? data.error : 'Error'}</div>`;
    return;
  }
  _limitsData = data.limits || [];
  renderLimitsTable();
}

function renderLimitsTable() {
  const content = document.getElementById('limits-content');
  const data = _limitsData;

  if (!data.length) {
    content.innerHTML = '<div class="nodata">No parameters with limits are configured.</div>';
    return;
  }

  // Filter buttons by section
  const sections = ['ALL', ...new Set(data.map(r => r.section))];
  const filtered = _limitsFilter === 'ALL' ? data : data.filter(r => r.section === _limitsFilter);

  // Group by section for display
  const bySection = {};
  filtered.forEach(r => { (bySection[r.section] = bySection[r.section] || []).push(r); });

  const val = v => (v === null || v === undefined || isNaN(v)) ? '' : v;
  const safe = id => id.replace(/[^a-zA-Z0-9]/g, '_');

  content.innerHTML = `
    <div style="font-size:12px;color:var(--txt3);margin-bottom:12px">
      Set the acceptable range per parameter. Values outside <strong>Warn</strong> show amber,
      outside <strong>Min/Max</strong> show red on the dashboard. Leave a field blank for no limit.
    </div>
    <div class="prefix-btns">
      ${sections.map(s => `<button class="prefix-btn ${_limitsFilter === s ? 'active' : ''}" onclick="setLimitsFilter('${s}')">${s}</button>`).join('')}
    </div>
    ${Object.entries(bySection).map(([section, rows]) => `
      <div class="section-block">
        <div class="section-block-title">${section}</div>
        <div class="tbl-wrap"><table class="dtbl limits-tbl">
          <thead><tr>
            <th>Parameter</th><th>Min (Crit)</th><th>Warn Min</th>
            <th>Warn Max</th><th>Max (Crit)</th><th>Unit</th><th></th>
          </tr></thead>
          <tbody>${rows.map(r => {
            const s = safe(r.limitId);
            return `<tr>
              <td class="td-label">${r.param}${r.exists ? '' : ' <span style="color:var(--txt3);font-size:10px">(not set)</span>'}</td>
              <td><input type="number" id="lim_min_${s}" value="${val(r.min)}" step="any" placeholder="—"></td>
              <td><input type="number" id="lim_wmin_${s}" value="${val(r.warnMin)}" step="any" placeholder="—"></td>
              <td><input type="number" id="lim_wmax_${s}" value="${val(r.warnMax)}" step="any" placeholder="—"></td>
              <td><input type="number" id="lim_max_${s}" value="${val(r.max)}" step="any" placeholder="—"></td>
              <td class="td-unit">${r.unit || ''}</td>
              <td><button class="save-lim" onclick="saveLimitRow('${r.limitId}')">Save</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`).join('')}`;
}

function setLimitsFilter(section) {
  _limitsFilter = section;
  renderLimitsTable();
}

async function saveLimitRow(limitId) {
  const safe = limitId.replace(/[^a-zA-Z0-9]/g, '_');
  const getVal = (sfx) => {
    const el = document.getElementById(`lim_${sfx}_${safe}`);
    return el && el.value !== '' ? parseFloat(el.value) : null;
  };

  const min = getVal('min'), max = getVal('max');
  const warnMin = getVal('wmin'), warnMax = getVal('wmax');
  if (min !== null && max !== null && min > max) {
    showToast('Min cannot be greater than Max', 'error'); return;
  }

  const result = await api('limits/upsert', { limitId, min, max, warnMin, warnMax });
  if (result && result.success) {
    cacheClear(); // dashboard/section status colors depend on limits
    showToast('Limit updated');
    const rec = _limitsData.find(x => x.limitId === limitId);
    if (rec) Object.assign(rec, { min, max, warnMin, warnMax, exists: true });
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
