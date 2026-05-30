'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { SH } = require('./config');

const _sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const ROLE_LABELS = {
  supervisor: 'Supervisor',
  management: 'Management',
  process1:   'Process Operator 1',
  process2:   'Process Operator 2',
  process3:   'Process Operator 3',
  meeting:    'Meeting View',
};

function _cleanSessions() {
  const now = Date.now();
  for (const [token, sess] of _sessions.entries()) {
    if (sess.expires < now) _sessions.delete(token);
  }
}

setInterval(_cleanSessions, 60 * 60 * 1000);

function _hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function validateSession(token) {
  if (!token) return null;
  const sess = _sessions.get(token);
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    _sessions.delete(token);
    return null;
  }
  return sess;
}

async function _findUser(username, sheets) {
  const rows = await sheets.getSheet(SH.USERS);
  const headers = await sheets.getSheetHeaders(SH.USERS);
  const idx = (h) => headers.findIndex(x => String(x).trim().toLowerCase() === h.toLowerCase());
  const uIdx    = idx('username');
  const phIdx   = idx('passwordhash');
  const roleIdx = idx('role');
  const nameIdx = idx('name');
  const emailIdx= idx('email');
  const actIdx  = idx('active');

  const { DB_START } = require('./config');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const u = uIdx >= 0 ? String(row[uIdx] || '').trim().toLowerCase() : '';
    if (u === username.trim().toLowerCase()) {
      return {
        username:     String(row[uIdx] || '').trim(),
        passwordHash: String(row[phIdx] || '').trim(),
        role:         String(row[roleIdx] || '').trim(),
        name:         String(row[nameIdx] || '').trim(),
        email:        String(row[emailIdx] || '').trim(),
        active:       String(row[actIdx] || '').trim().toLowerCase(),
        rowNum:       DB_START + i,
        rowArray:     row,
        headers,
      };
    }
  }
  return null;
}

async function loginUser(payload, sheets) {
  _cleanSessions();
  const { username, password } = payload;
  if (!username || !password) return { error: 'Username and password required.' };

  let user;
  try {
    user = await _findUser(username, sheets);
  } catch (err) {
    console.error('loginUser error:', err.message);
    return { error: 'Could not reach database. Check server configuration.' };
  }

  if (!user) return { error: 'Invalid username or password.' };
  if (user.active === 'false' || user.active === '0' || user.active === 'no') {
    return { error: 'Account is disabled. Contact administrator.' };
  }

  const hash = _hashPassword(password);
  if (hash !== user.passwordHash) return { error: 'Invalid username or password.' };

  const token = uuidv4();
  const sess = {
    username: user.username,
    role:     user.role,
    name:     user.name,
    email:    user.email,
    expires:  Date.now() + SESSION_TTL_MS,
  };
  _sessions.set(token, sess);

  return {
    success:   true,
    token,
    role:      user.role,
    name:      user.name,
    roleLabel: ROLE_LABELS[user.role] || user.role,
  };
}

function logoutUser(payload) {
  const { token } = payload;
  if (token) _sessions.delete(token);
  return { success: true };
}

async function getAllUsers(token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const rows = await sheets.getSheet(SH.USERS);
  const headers = await sheets.getSheetHeaders(SH.USERS);
  const idx = (h) => headers.findIndex(x => String(x).trim().toLowerCase() === h.toLowerCase());
  const uIdx    = idx('username');
  const roleIdx = idx('role');
  const nameIdx = idx('name');
  const emailIdx= idx('email');
  const actIdx  = idx('active');
  const { DB_START } = require('./config');

  return rows.map((row, i) => ({
    username: String(row[uIdx] || '').trim(),
    role:     String(row[roleIdx] || '').trim(),
    name:     String(row[nameIdx] || '').trim(),
    email:    String(row[emailIdx] || '').trim(),
    active:   String(row[actIdx] || '').trim(),
    rowNum:   DB_START + i,
  })).filter(u => u.username);
}

async function saveUser(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const { username, role, name, email, password, active } = payload;
  if (!username || !role) return { error: 'Username and role are required.' };

  const existing = await _findUser(username, sheets);
  const passwordHash = password ? _hashPassword(password) : (existing ? existing.passwordHash : _hashPassword('changeme'));
  const rowArray = [username, passwordHash, role, name || '', email || '', active !== undefined ? String(active) : 'true'];

  if (existing) {
    await sheets.updateRow(SH.USERS, existing.rowNum, rowArray);
  } else {
    await sheets.appendRow(SH.USERS, rowArray);
  }
  return { success: true };
}

async function changePassword(payload, token, sheets) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const { currentPassword, newPassword } = payload;
  if (!currentPassword || !newPassword) return { error: 'Both current and new password required.' };
  if (newPassword.length < 6) return { error: 'New password must be at least 6 characters.' };

  const user = await _findUser(sess.username, sheets);
  if (!user) return { error: 'User not found.' };

  const currentHash = _hashPassword(currentPassword);
  if (currentHash !== user.passwordHash) return { error: 'Current password is incorrect.' };

  const newHash = _hashPassword(newPassword);
  const headers = user.headers;
  const phIdx = headers.findIndex(x => String(x).trim().toLowerCase() === 'passwordhash');
  if (phIdx < 0) return { error: 'Cannot find password column.' };

  const newRow = [...(user.rowArray || [])];
  while (newRow.length <= phIdx) newRow.push('');
  newRow[phIdx] = newHash;
  await sheets.updateRow(SH.USERS, user.rowNum, newRow);

  return { success: true };
}

module.exports = {
  validateSession, loginUser, logoutUser,
  getAllUsers, saveUser, changePassword,
  ROLE_LABELS,
};
