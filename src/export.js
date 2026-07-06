'use strict';

const XLSX = require('xlsx');

/**
 * Builds an .xlsx buffer from a section-data response (getSectionData result):
 * header row from params, one row per reading.
 */
function sectionWorkbook(data) {
  const params = (data.params || []).filter(p => p.key !== 'Date' && p.key !== 'Time' && p.key !== 'Shift');
  const hasTime  = (data.rows[0] || {}).__time  !== undefined;
  const hasShift = (data.rows[0] || {}).__shift !== undefined;

  const header = ['Date'];
  if (hasTime)  header.push('Time');
  if (hasShift) header.push('Shift');
  params.forEach(p => header.push(p.unit ? `${p.key}` : p.key));

  const rows = (data.rows || []).map(r => {
    const out = [r.__date || ''];
    if (hasTime)  out.push(r.__time  || '');
    if (hasShift) out.push(r.__shift || '');
    params.forEach(p => out.push(r[p.key] !== undefined && r[p.key] !== null ? r[p.key] : ''));
    return out;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, (data.label || 'Data').slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Builds an .xlsx buffer from a monthly-report response (getMonthlyReport result):
 * one tab per block (Summary, Chemicals, Stoppages).
 */
function reportWorkbook(report) {
  const wb = XLSX.utils.book_new();

  const summary = [['Monthly Report', report.month], []];
  if (report.crushing) {
    summary.push(['CRUSHING']);
    summary.push(['Running Hours', report.crushing.runHours]);
    summary.push(['Production (t)', report.crushing.production]);
    summary.push(['Avg TPH', report.crushing.avgTph]);
    summary.push([]);
  }
  if (report.milling) {
    summary.push(['MILLING']);
    summary.push(['Running Hours', report.milling.runHours]);
    summary.push(['Production (t)', report.milling.production]);
    summary.push(['Avg Feed Grade (g/t)', report.milling.feedGrade]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');

  if (report.chemicals && report.chemicals.length) {
    const rows = [['Chemical', 'Unit', 'Total Consumed']];
    report.chemicals.forEach(c => rows.push([c.name, c.unit, c.total]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Chemicals');
  }

  if (report.stoppages) {
    const s = report.stoppages;
    const rows = [['Total Stoppage Hours', s.total], []];
    rows.push(['By Section', 'Hours']);
    (s.bySection || []).forEach(x => rows.push([x.section, x.hrs]));
    rows.push([]);
    rows.push(['By Department', 'Hours']);
    (s.byDept || []).forEach(x => rows.push([x.dept, x.hrs]));
    rows.push([]);
    rows.push(['Top Reasons', 'Hours']);
    (s.topReasons || []).forEach(x => rows.push([x.reason, x.hrs]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Stoppages');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { sectionWorkbook, reportWorkbook };
