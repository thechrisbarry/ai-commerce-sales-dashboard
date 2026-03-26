const https = require('https');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1dHVNK3-YdnyBNoiVMcSuWJKy5oyWbIx6UdIa_w4XX_o';

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : new URLSearchParams(data).toString();
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, path: parsed.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: { 'Authorization': 'Bearer ' + token } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async function(event, context) {
  try {
    // Get fresh access token
    const tokenResp = await httpPost('https://oauth2.googleapis.com/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    });

    if (!tokenResp.access_token) {
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Token refresh failed' }) };
    }

    // Pull sheet data
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Log!A1:T1000?majorDimension=ROWS`;
    const sheetData = await httpGet(sheetUrl, tokenResp.access_token);

    if (!sheetData.values) {
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'No sheet data' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ headers: sheetData.values[0], rows: sheetData.values.slice(1), updated: new Date().toISOString() })
    };
  } catch (e) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message }) };
  }
};
