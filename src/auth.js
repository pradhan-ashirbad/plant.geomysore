'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { SH } = require('./config');

const SESSION_TTL = '8h'; // 8 hours
const JWT_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

const ROLE_LABELS = {
  supervisor: 'Supervisor',
  management: 'Management',
  process1:   'Process Operator 1',
  process2:   'Process Operator 2',
  process3:   'Process Operator 3',
  meeting:    'Meeting View',
};

function _hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

/**
 * Validate session token (a signed JWT). Returns session object or null.
 * Stateless — works across separate serverless invocations.
 */
function validateSession(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return {
      username: payload.username,
      role:     payload.role,
      name:     payload.name,
      email:    payload.email,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Find a user row in the USERS sheet.
 * Sheet columns (row 4 headers): Username | PasswordHash | Role | Name | Email | Active
 * Returns { username, passwordHash, role, name, email, active, rowNum }
 */
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

/**
 * loginUser({ username, password }, sheets) → { success, token, role, name, roleLabel } | { error }
 */
async function loginUser(payload, sheets) {
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

  const token = jwt.sign(
    { username: user.username, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  );

  return {
    success:   true,
    token,
    role:      user.role,
    name:      user.name,
    roleLabel: ROLE_LABELS[user.role] || user.role,
  };
}

/**
 * logoutUser({ token }) → { success }
 * With stateless JWTs, logout is a client-side no-op (client discards the token).
 */
function logoutUser(payload) {
  return { success: true };
}

/**
 * getAllUsers(token, sheets) → array of user objects
 */
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

/**
 * saveUser(payload, token, sheets) → { success } | { error }
 * payload: { username, role, name, email, password?, active }
 * If username matches existing user, update that row. Otherwise append new.
 */
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

/**
 * changePassword(payload, token, sheets) → { success } | { error }
 * payload: { currentPassword, newPassword }
 */
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
  // Pad if needed
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
