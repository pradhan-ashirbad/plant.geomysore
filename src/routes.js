'use strict';

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const sheets  = require('./db');
const auth    = require('./auth');
const data    = require('./data');
const importer = require('./import');

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

// ─── LIMITS ROUTES ────────────────────────────────────────────────────────────

router.post('/limits',         handle((body) => data.getAllLimits(body.token, sheets)));
router.post('/limits/update',  handle((body) => data.updateLimit(body, body.token, sheets)));

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

module.exports = router;
