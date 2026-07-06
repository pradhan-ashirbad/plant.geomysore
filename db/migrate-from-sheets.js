'use strict';
/**
 * One-time migration: reads your existing Google Sheet and inserts all data
 * into the new Supabase Postgres database.
 *
 * Usage:
 *   GOOGLE_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_KEY='...' DATABASE_URL=... node db/migrate-from-sheets.js
 *
 * Requires the OLD Google Sheets credentials (one last time) plus the NEW
 * DATABASE_URL. Safe to re-run — it clears and re-inserts each sheet's rows.
 */

require('dotenv').config();
const { google } = require('googleapis');
const { Pool } = require('pg');
const { SH, DB_START, SHEET_PARAMS } = require('../src/config');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function getServiceAccountKey() {
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getServiceAccountKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchRange(client, sheetName, range) {
  try {
    const resp = await client.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!${range}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return resp.data.values || [];
  } catch (err) {
    console.warn(`  (skip ${sheetName}: ${err.message})`);
    return [];
  }
}

async function migrateUsers(client) {
  console.log('Migrating USERS...');
  const rows = await fetchRange(client, SH.USERS, `A${DB_START}:F`);
  for (const row of rows) {
    const [username, passwordHash, role, name, email, active] = row;
    if (!username) continue;
    await pool.query(
      `INSERT INTO users (username, password_hash, role, name, email, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (username) DO UPDATE SET password_hash=$2, role=$3, name=$4, email=$5, active=$6`,
      [String(username).trim(), String(passwordHash || ''), String(role || ''), String(name || ''), String(email || ''),
       String(active || 'true').toLowerCase() !== 'false']
    );
  }
  console.log(`  ${rows.length} users migrated.`);
}

async function migrateGenericSheet(client, sheetName, headers) {
  console.log(`Migrating ${sheetName}...`);
  const rows = await fetchRange(client, sheetName, `A${DB_START}:ZZ`);
  if (!rows.length) { console.log('  0 rows.'); return; }

  await pool.query(
    `INSERT INTO sheet_headers (sheet_name, headers) VALUES ($1, $2)
     ON CONFLICT (sheet_name) DO UPDATE SET headers = $2`,
    [sheetName, JSON.stringify(headers)]
  );
  await pool.query('DELETE FROM sheet_rows WHERE sheet_name = $1', [sheetName]);
  for (const row of rows) {
    await pool.query('INSERT INTO sheet_rows (sheet_name, row_data) VALUES ($1, $2)', [sheetName, JSON.stringify(row)]);
  }
  console.log(`  ${rows.length} rows migrated.`);
}

async function main() {
  const client = await getSheetsClient();

  await migrateUsers(client);

  const FIXED_HEADERS = {
    [SH.LIMITS]:   ['ID', 'Label', 'Prefix', 'Min', 'Max', 'Warn Min', 'Warn Max', 'Unit'],
    [SH.TARGETS]:  ['Month', 'Param ID', 'Param', 'Unit', 'Target', 'Notes', 'Set By', 'Updated'],
    [SH.CHEM_INV]: ['Chemical', 'Quantity', 'Unit', 'Min Stock', 'Reorder Level', 'Updated'],
  };

  for (const [key, headers] of Object.entries(FIXED_HEADERS)) {
    await migrateGenericSheet(client, key, headers);
  }

  for (const [sheetName, params] of Object.entries(SHEET_PARAMS)) {
    if (FIXED_HEADERS[sheetName]) continue; // already handled above
    if (!params || !params.length) continue;
    const headers = [...params.map(p => p.key), 'Submitted By', 'Timestamp'];
    await migrateGenericSheet(client, sheetName, headers);
  }

  console.log('Migration complete.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
