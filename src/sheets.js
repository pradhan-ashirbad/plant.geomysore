'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { DB_START } = require('./config');

let _auth = null;
let _sheets = null;

function _getServiceAccountKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
    }
  }
  const filePath = path.join(__dirname, '..', 'service-account.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  throw new Error('No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_KEY env var or provide service-account.json');
}

function _getClient() {
  if (_sheets) return _sheets;
  const key = _getServiceAccountKey();
  _auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: _auth });
  return _sheets;
}

function _spreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID environment variable is not set');
  return id;
}

function _range(sheetName, range) {
  return `'${sheetName}'!${range}`;
}

/**
 * Returns all rows from DB_START (row 5) onward as array-of-arrays.
 * Each inner array is a row of raw cell values.
 */
async function getSheet(sheetName) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const rangeStr = _range(sheetName, `A${DB_START}:ZZ`);
  try {
    const resp = await client.spreadsheets.values.get({ spreadsheetId, range: rangeStr, valueRenderOption: 'UNFORMATTED_VALUE' });
    return resp.data.values || [];
  } catch (err) {
    if (err.code === 400 || err.message?.includes('Unable to parse range')) {
      // Sheet might not exist yet
      return [];
    }
    throw err;
  }
}

/**
 * Returns the header row (row 4, index DB_START-2 = 3 in full data) as an array.
 */
async function getSheetHeaders(sheetName) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const rangeStr = _range(sheetName, `A${DB_START - 1}:ZZ${DB_START - 1}`);
  try {
    const resp = await client.spreadsheets.values.get({ spreadsheetId, range: rangeStr, valueRenderOption: 'UNFORMATTED_VALUE' });
    const rows = resp.data.values || [];
    return rows[0] || [];
  } catch (err) {
    if (err.code === 400 || err.message?.includes('Unable to parse range')) return [];
    throw err;
  }
}

/**
 * Returns all rows including the header rows (rows 1-4+), full range.
 */
async function getSheetFull(sheetName) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const rangeStr = _range(sheetName, 'A1:ZZ');
  try {
    const resp = await client.spreadsheets.values.get({ spreadsheetId, range: rangeStr, valueRenderOption: 'UNFORMATTED_VALUE' });
    return resp.data.values || [];
  } catch (err) {
    if (err.code === 400 || err.message?.includes('Unable to parse range')) return [];
    throw err;
  }
}

/**
 * Appends a row to the sheet (after the last data row).
 */
async function appendRow(sheetName, rowArray) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const rangeStr = _range(sheetName, 'A:A');
  await client.spreadsheets.values.append({
    spreadsheetId,
    range: rangeStr,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] },
  });
}

/**
 * Updates a specific row (1-indexed, where row 1 = the first row of the sheet).
 * rowNum should be the actual sheet row number (e.g., 5 for the first data row).
 */
async function updateRow(sheetName, rowNum, rowArray) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const rangeStr = _range(sheetName, `A${rowNum}:ZZ${rowNum}`);
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: rangeStr,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowArray] },
  });
}

/**
 * Updates a single cell. row and col are 1-indexed.
 */
async function updateCell(sheetName, row, col, value) {
  const client = _getClient();
  const spreadsheetId = _spreadsheetId();
  const colLetter = _colNumToLetter(col);
  const rangeStr = _range(sheetName, `${colLetter}${row}`);
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: rangeStr,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

function _colNumToLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { getSheet, getSheetHeaders, getSheetFull, appendRow, updateRow, updateCell };
