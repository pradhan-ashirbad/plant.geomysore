'use strict';

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const sheets  = require('./db');
const auth    = require('./auth');
const data    = require('./data');
const importer = require('./import');
const exporter = require('./export');
const leachHistory = require('../db/migrate-leaching-history');
const detoxHistory = require('../db/migrate-detox-history');
const slurryHistory = require('../db/migrate-slurry-history');
const stoppageHistory = require('../db/migrate-stoppage-history');
const filterPressHistory = require('../db/migrate-filterpress-history');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body, sheets);
      res.json(result);
    } catch (err) {
      console.error(req.path, err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

router.post('/login', handle((body) => auth.loginUser(body)));

router.post('/logout', (req, res) => {
  res.json(auth.logoutUser(req.body));
});

// ─── DATA ROUTES ──────────────────────────────────────────────────────────────

router.post('/dashboard',      handle((body) => data.getIndexData(body, sheets)));
router.post('/section',        handle((body) => data.getSectionData(body, sheets)));
router.post('/entry-config',   handle((body) => data.getEntryFormConfig(body, sheets)));
router.post('/submit',         handle((body) => data.submitData(body, sheets)));
router.post('/report',         handle((body) => data.getMonthlyReport(body, sheets)));
router.post('/alerts',         handle((body) => data.getAlerts(body, sheets)));

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────

router.get('/export/section', async (req, res) => {
  try {
    const { token, section, date, month, from, to } = req.query;
    const result = await data.getSectionData({ token, section, date, month, from, to }, sheets);
    if (result.error) return res.status(result.error === 'SESSION_EXPIRED' ? 401 : 403).json(result);
    if (!result.hasData) return res.status(404).json({ error: 'No data for this period.' });

    const buf = exporter.sectionWorkbook(result);
    const fname = `${result.label.replace(/[^a-zA-Z0-9]+/g, '_')}_${(result.date || 'all').replace(/[^0-9a-zA-Z-]+/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(buf);
  } catch (err) {
    console.error('/export/section', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/report', async (req, res) => {
  try {
    const { token, month } = req.query;
    const result = await data.getMonthlyReport({ token, month }, sheets);
    if (result.error) return res.status(result.error === 'SESSION_EXPIRED' ? 401 : 403).json(result);

    const buf = exporter.reportWorkbook(result);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Monthly_Report_${month}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('/export/report', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIMITS ROUTES ────────────────────────────────────────────────────────────

router.post('/limits',         handle((body) => data.getAllLimits(body.token, sheets)));
router.post('/limits/update',  handle((body) => data.updateLimit(body, body.token, sheets)));
router.post('/limits/catalog', handle((body) => data.getLimitCatalog(body.token, sheets)));
router.post('/limits/upsert',  handle((body) => data.upsertLimit(body, body.token, sheets)));
router.post('/params-catalog', handle((body) => data.getParamCatalog(body)));

// ─── TARGETS ROUTES ───────────────────────────────────────────────────────────

router.post('/targets',        handle((body) => data.getAllTargets(body.token, sheets)));
router.post('/targets/save',   handle((body) => data.saveTarget(body, body.token, sheets)));

// ─── CHEMICAL INVENTORY ───────────────────────────────────────────────────────

router.post('/chem-inventory',        handle((body) => data.getChemicalInventory(body.token, sheets)));
router.post('/chem-inventory/update', handle((body) => data.updateChemInventory(body, body.token, sheets)));

// ─── USER ADMIN ───────────────────────────────────────────────────────────────

router.post('/users',           handle((body) => auth.getAllUsers(body.token)));
router.post('/users/save',      handle((body) => auth.saveUser(body, body.token)));
router.post('/change-password', handle((body) => auth.changePassword(body, body.token)));

// ─── DATA IMPORT (Excel) ──────────────────────────────────────────────────────

router.get('/import/sheets', (req, res) => {
  const sess = auth.validateSession(req.query.token);
  if (!sess) return res.status(401).json({ error: 'SESSION_EXPIRED' });
  if (sess.role !== 'supervisor') return res.status(403).json({ error: 'Access denied.' });
  res.json({ sheets: importer.IMPORTABLE_SHEETS });
});

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    const sess = auth.validateSession(req.body.token);
    if (!sess) return res.status(401).json({ error: 'SESSION_EXPIRED' });
    if (sess.role !== 'supervisor') return res.status(403).json({ error: 'Access denied.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { sheetName, mode } = req.body;
    if (!sheetName) return res.status(400).json({ error: 'sheetName is required.' });

    const { headers, rows } = importer.parseWorkbook(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in the file.' });

    const result = await importer.importIntoSheet(sheetName, headers, rows, mode === 'replace' ? 'replace' : 'append');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('/import', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LEACHING/DETOX HISTORY BACKFILL (one-off admin tool) ─────────────────────
// Lets a supervisor upload the plant's historical Leaching CN/pH log and/or
// Detox log workbooks straight from the browser instead of running
// db/migrate-leaching-history.js / db/migrate-detox-history.js from a
// terminal. Both files go through the exact same parsing + db.appendRow
// path those scripts use — this route is just a browser-facing wrapper.
router.post('/admin/import-leaching-history',
  upload.fields([{ name: 'leaching', maxCount: 1 }, { name: 'detox', maxCount: 1 }, { name: 'slurry', maxCount: 1 }, { name: 'stoppage', maxCount: 1 }, { name: 'filterpress', maxCount: 1 }]),
  async (req, res) => {
    try {
      const sess = auth.validateSession(req.body.token);
      if (!sess) return res.status(401).json({ error: 'SESSION_EXPIRED' });
      if (sess.role !== 'supervisor') return res.status(403).json({ error: 'Access denied.' });

      const files = req.files || {};
      if (!files.leaching && !files.detox && !files.slurry && !files.stoppage && !files.filterpress) {
        return res.status(400).json({ error: 'Upload at least one workbook (Leaching, Detox, Slurry, Filter Press, and/or Stoppage).' });
      }

      const defaultYear = req.body.year && /^\d{4}$/.test(req.body.year) ? req.body.year : null;
      const result = {};

      if (files.leaching) {
        const skippedCols = new Set();
        const r = await leachHistory.processWorkbook(files.leaching[0].buffer, skippedCols, { defaultYear });
        result.leaching = { ...r, skippedCols: Array.from(skippedCols).sort() };
      }
      if (files.detox) {
        const skippedCols = new Set();
        const r = await detoxHistory.processWorkbook(files.detox[0].buffer, skippedCols);
        result.detox = { ...r, skippedCols: Array.from(skippedCols).sort() };
      }
      if (files.slurry) {
        const skippedCols = new Set();
        const r = await slurryHistory.processWorkbook(files.slurry[0].buffer, skippedCols);
        result.slurry = { ...r, skippedCols: Array.from(skippedCols).sort() };
      }
      if (files.stoppage) {
        const r = await stoppageHistory.processWorkbook(files.stoppage[0].buffer);
        result.stoppage = { ...r };
      }
      if (files.filterpress) {
        const skippedCols = new Set();
        const r = await filterPressHistory.processWorkbook(files.filterpress[0].buffer, skippedCols);
        result.filterpress = { ...r, skippedCols: Array.from(skippedCols).sort() };
      }

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('/admin/import-leaching-history', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
