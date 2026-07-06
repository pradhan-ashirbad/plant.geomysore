'use strict';

const { Pool } = require('pg');

let _pool = null;
function _getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set');
  _pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return _pool;
}

function query(text, params) {
  return _getPool().query(text, params);
}

module.exports = { query };
