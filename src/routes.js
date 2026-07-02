'use strict';

const express = require('express');
const router  = express.Router();
const sheets  = require('./db');
const auth    = require('./auth');
const data    = require('./data');

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

module.exports = router;
