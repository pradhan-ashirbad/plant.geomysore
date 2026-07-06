'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

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

async function _findUser(username) {
  const res = await db.query(
    'SELECT id, username, password_hash, role, name, email, active FROM users WHERE lower(username) = lower($1)',
    [username]
  );
  return res.rows[0] || null;
}

/**
 * loginUser({ username, password }) → { success, token, role, name, roleLabel } | { error }
 */
async function loginUser(payload) {
  const { username, password } = payload;
  if (!username || !password) return { error: 'Username and password required.' };

  let user;
  try {
    user = await _findUser(username);
  } catch (err) {
    console.error('loginUser error:', err.message);
    return { error: 'Could not reach database. Check server configuration.' };
  }

  if (!user) return { error: 'Invalid username or password.' };
  if (user.active === false) return { error: 'Account is disabled. Contact administrator.' };

  const hash = _hashPassword(password);
  if (hash !== user.password_hash) return { error: 'Invalid username or password.' };

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
 * getAllUsers(token) → array of user objects
 */
async function getAllUsers(token) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const res = await db.query('SELECT id, username, role, name, email, active FROM users ORDER BY id ASC');
  return res.rows.map(u => ({
    username: u.username,
    role:     u.role,
    name:     u.name || '',
    email:    u.email || '',
    active:   String(u.active),
    rowNum:   u.id,
  }));
}

/**
 * saveUser(payload, token) → { success } | { error }
 * payload: { username, role, name, email, password?, active }
 * If username matches existing user, update that row. Otherwise insert new.
 */
async function saveUser(payload, token) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };
  if (sess.role !== 'supervisor') return { error: 'Access denied.' };

  const { username, role, name, email, password, active } = payload;
  if (!username || !role) return { error: 'Username and role are required.' };

  const existing = await _findUser(username);
  const passwordHash = password ? _hashPassword(password) : (existing ? existing.password_hash : _hashPassword('changeme'));
  const isActive = active !== undefined ? !!active && active !== 'false' : true;

  if (existing) {
    await db.query(
      'UPDATE users SET password_hash=$1, role=$2, name=$3, email=$4, active=$5 WHERE id=$6',
      [passwordHash, role, name || '', email || '', isActive, existing.id]
    );
  } else {
    await db.query(
      'INSERT INTO users (username, password_hash, role, name, email, active) VALUES ($1,$2,$3,$4,$5,$6)',
      [username, passwordHash, role, name || '', email || '', isActive]
    );
  }
  return { success: true };
}

/**
 * changePassword(payload, token) → { success } | { error }
 * payload: { currentPassword, newPassword }
 */
async function changePassword(payload, token) {
  const sess = validateSession(token);
  if (!sess) return { error: 'SESSION_EXPIRED' };

  const { currentPassword, newPassword } = payload;
  if (!currentPassword || !newPassword) return { error: 'Both current and new password required.' };
  if (newPassword.length < 6) return { error: 'New password must be at least 6 characters.' };

  const user = await _findUser(sess.username);
  if (!user) return { error: 'User not found.' };

  const currentHash = _hashPassword(currentPassword);
  if (currentHash !== user.password_hash) return { error: 'Current password is incorrect.' };

  const newHash = _hashPassword(newPassword);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, user.id]);

  return { success: true };
}

module.exports = {
  validateSession, loginUser, logoutUser,
  getAllUsers, saveUser, changePassword,
  ROLE_LABELS,
};
