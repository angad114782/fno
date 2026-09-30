// Upstox API v2/v3 client: login (OAuth), LTP, candles, option chain.
// Docs: https://upstox.com/developer/api-documentation
const config = require('../config/env');
const Setting = require('../models/Setting');
const HttpError = require('../utils/httpError');

const BASE = 'https://api.upstox.com';
const TOKEN_KEY = 'upstox_token';

let cached = null; // { token, expiresAt, source }

// Upstox login token roz subah ~3:30 AM IST expire hota hai
function nextExpiry(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(22, 0, 0, 0); // 03:30 IST
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function getToken() {
  if (config.upstox.accessToken) return { token: config.upstox.accessToken, source: 'env' };
  if (cached && cached.expiresAt > new Date()) return cached;
  const s = await Setting.findOne({ key: TOKEN_KEY });
  if (s && s.expiresAt > new Date()) {
    cached = { token: s.value.accessToken, expiresAt: s.expiresAt, source: 'login', user: s.value.userName };
    return cached;
  }
  return null;
}

async function status() {
  const t = await getToken();
  return {
    configured: Boolean(config.upstox.apiKey && config.upstox.apiSecret) || Boolean(config.upstox.accessToken),
    connected: Boolean(t),
    source: t?.source || null,
    user: t?.user || null,
    expiresAt: t?.expiresAt || null,
    redirectUri: config.upstox.redirectUri,
  };
}

function loginUrl(state = '') {
  if (!config.upstox.apiKey) throw new HttpError(400, 'UPSTOX_API_KEY .env me set nahi hai');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.upstox.apiKey,
    redirect_uri: config.upstox.redirectUri,
    state,
  });
  return `${BASE}/v2/login/authorization/dialog?${q}`;
}

async function exchangeCode(code) {
  const res = await fetch(`${BASE}/v2/login/authorization/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: config.upstox.apiKey,
      client_secret: config.upstox.apiSecret,
      redirect_uri: config.upstox.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.errors?.[0]?.message || data.message || res.statusText;
    throw new HttpError(400, `Upstox login failed: ${msg}`);
  }
  const expiresAt = nextExpiry();
  await Setting.findOneAndUpdate(
    { key: TOKEN_KEY },
    { value: { accessToken: data.access_token, userName: data.user_name, userId: data.user_id }, expiresAt },
    { upsert: true }
  );
  cached = { token: data.access_token, expiresAt, source: 'login', user: data.user_name };
  return cached;
}

async function logout() {
  cached = null;
  await Setting.deleteOne({ key: TOKEN_KEY });
}

async function request(path, { query } = {}) {
  const t = await getToken();
  if (!t) throw new HttpError(424, 'Upstox connected nahi hai - dashboard pe "Connect Upstox" karo');
  const url = `${BASE}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${t.token}` } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (t.source === 'login') await logout();
    throw new HttpError(424, 'Upstox token expire ho gaya - dobara "Connect Upstox" karo');
  }
  if (!res.ok || data.status === 'error') {
    const msg = data.errors?.[0]?.message || data.message || res.statusText;
    throw new HttpError(502, `Upstox error: ${msg}`);
  }
  return data.data;
}

// keys: ['NSE_FO|50978', ...] -> { 'NSE_FO|50978': 123.4 }
async function getLtp(keys) {
  const out = {};
  const uniq = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 500) {
    const data = await request('/v3/market-quote/ltp', { query: { instrument_key: uniq.slice(i, i + 500).join(',') } });
    for (const q of Object.values(data || {})) {
      if (q && q.instrument_token) out[q.instrument_token] = q.last_price;
    }
  }
  return out;
}

const istDate = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);
const parseCandles = (data) =>
  (data?.candles || []).map(([time, open, high, low, close, volume, oi]) => ({ time, open, high, low, close, volume, oi }));

// Upstox ek request me limited range deta hai -> chunks me fetch
function chunkDays(unit, interval) {
  if (unit === 'minutes') return interval <= 15 ? 28 : 88;
  if (unit === 'hours') return 88;
  if (unit === 'days') return 3600;
  return 36500;
}

/**
 * Historical + (aaj ka) intraday candles, oldest first.
 * unit: minutes|hours|days|weeks|months, interval: number, from/to: 'YYYY-MM-DD'
 */
async function getCandles(instrumentKey, { unit = 'minutes', interval = 5, from, to } = {}) {
  const today = istDate(new Date());
  const toDate = to || today;
  const fromDate = from || toDate;
  const key = encodeURIComponent(instrumentKey);
  const step = chunkDays(unit, interval);
  const byTime = new Map();

  let end = new Date(`${toDate}T00:00:00Z`);
  const start = new Date(`${fromDate}T00:00:00Z`);
  while (end >= start) {
    const chunkStart = new Date(Math.max(start.getTime(), end.getTime() - (step - 1) * 86400000));
    const f = chunkStart.toISOString().slice(0, 10);
    const t = end.toISOString().slice(0, 10);
    const data = await request(`/v3/historical-candle/${key}/${unit}/${interval}/${t}/${f}`);
    for (const c of parseCandles(data)) byTime.set(c.time, c);
    end = new Date(chunkStart.getTime() - 86400000);
  }

  if (toDate >= today && ['minutes', 'hours', 'days'].includes(unit)) {
    try {
      const data = await request(`/v3/historical-candle/intraday/${key}/${unit}/${interval}`);
      for (const c of parseCandles(data)) byTime.set(c.time, c);
    } catch (err) {
      if (err.status === 424) throw err; // intraday na mile (market band) to ignore
    }
  }
  return [...byTime.values()].sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function getOptionChain(underlyingKey, expiry) {
  const data = await request('/v2/option/chain', { query: { instrument_key: underlyingKey, expiry_date: expiry } });
  return (data || []).sort((a, b) => a.strike_price - b.strike_price);
}

module.exports = { status, loginUrl, exchangeCode, logout, getToken, request, getLtp, getCandles, getOptionChain, istDate, nextExpiry };
