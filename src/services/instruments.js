// Upstox instruments master (public gz files, login nahi chahiye), roz ek baar refresh.
// Symbol (NIFTY / RELIANCE) -> underlying key, lot size, expiries aur option contracts.
const zlib = require('zlib');
const { istDate } = require('./upstox');

const FILES = [
  'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
];

let store = null; // { day, bySymbol: Map<symbol, info>, eq: Map<symbol, key>, indexByName }
let loading = null;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Instrument file download failed ${res.status}: ${url}`);
  return JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
}

function build(rows) {
  const bySymbol = new Map();
  const eq = new Map();
  const indices = new Map();
  for (const r of rows) {
    if (r.segment === 'NSE_EQ' && r.instrument_type === 'EQ') eq.set(r.trading_symbol, { key: r.instrument_key, name: r.name });
    else if ((r.segment === 'NSE_INDEX' || r.segment === 'BSE_INDEX') && r.trading_symbol) {
      indices.set(r.trading_symbol.toUpperCase(), { key: r.instrument_key, name: r.name });
    } else if ((r.segment === 'NSE_FO' || r.segment === 'BSE_FO') && r.underlying_symbol) {
      const sym = r.underlying_symbol.toUpperCase();
      let info = bySymbol.get(sym);
      if (!info) {
        info = {
          symbol: sym,
          underlyingKey: r.underlying_key,
          type: r.underlying_type === 'INDEX' ? 'INDEX' : 'STOCK',
          exchange: r.segment === 'BSE_FO' ? 'BSE' : 'NSE',
          lotSize: r.lot_size,
          options: [],
          futures: [],
        };
        bySymbol.set(sym, info);
      }
      const c = {
        key: r.instrument_key,
        tradingSymbol: r.trading_symbol,
        expiry: istDate(r.expiry),
        strike: r.strike_price,
        type: r.instrument_type,
        lotSize: r.lot_size,
      };
      if (r.instrument_type === 'FUT') info.futures.push(c);
      else if (r.instrument_type === 'CE' || r.instrument_type === 'PE') info.options.push(c);
    }
  }
  for (const info of bySymbol.values()) {
    info.futures.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    info.expiries = [...new Set(info.options.map((o) => o.expiry))].sort();
    // nearest contract ka lot size (lot size revise hota rehta hai)
    const near = info.futures[0] || info.options.find((o) => o.expiry === info.expiries[0]);
    if (near) info.lotSize = near.lotSize;
    // strike gap (nearest expiry ke strikes me sabse aam antar)
    const ks = [...new Set(info.options.filter((o) => o.expiry === info.expiries[0]).map((o) => o.strike))].sort((a, b) => a - b);
    const gaps = new Map();
    for (let i = 1; i < ks.length; i++) gaps.set(ks[i] - ks[i - 1], (gaps.get(ks[i] - ks[i - 1]) || 0) + 1);
    info.strikeStep = [...gaps].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  return { bySymbol, eq, indices };
}

async function load() {
  const day = istDate(new Date());
  if (store && store.day === day) return store;
  if (!loading) {
    loading = (async () => {
      const lists = await Promise.all(FILES.map(download));
      store = { day, ...build(lists.flat()) };
      return store;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * NIFTY / BANKNIFTY / RELIANCE ... -> { symbol, underlyingKey, type, lotSize, expiries, hasFno }
 */
async function resolve(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  const st = await load();
  const fo = st.bySymbol.get(s);
  if (fo) {
    const today = istDate(new Date());
    return {
      symbol: s,
      underlyingKey: fo.underlyingKey,
      type: fo.type,
      exchange: fo.exchange,
      lotSize: fo.lotSize,
      strikeStep: fo.strikeStep,
      expiries: fo.expiries.filter((e) => e >= today),
      futures: fo.futures.filter((f) => f.expiry >= today),
      hasFno: true,
    };
  }
  const e = st.eq.get(s) || st.indices.get(s);
  if (e) return { symbol: s, underlyingKey: e.key, name: e.name, type: st.eq.has(s) ? 'STOCK' : 'INDEX', lotSize: null, expiries: [], futures: [], hasFno: false };
  return null;
}

// Trade ke contract ka Upstox instrument key (live LTP ke liye)
async function contractKey({ underlying, segment, optionType, strike, expiry }) {
  const st = await load();
  const info = st.bySymbol.get(String(underlying).toUpperCase());
  if (!info) return null;
  const exp = istDate(expiry);
  if (segment === 'FUT') return info.futures.find((f) => f.expiry === exp)?.key || null;
  return info.options.find((o) => o.expiry === exp && o.type === optionType && o.strike === Number(strike))?.key || null;
}

// Saare F&O underlyings (INDEX / STOCK)
async function fnoList(type) {
  const st = await load();
  return [...st.bySymbol.values()].filter((i) => !type || i.type === type).map((i) => i.symbol).sort();
}

async function search(q, limit = 20) {
  const s = String(q || '').toUpperCase().trim();
  const st = await load();
  const out = [];
  for (const info of st.bySymbol.values()) {
    if (!s || info.symbol.startsWith(s)) out.push({ symbol: info.symbol, type: info.type, lotSize: info.lotSize });
  }
  return out.sort((a, b) => (a.type === b.type ? a.symbol.localeCompare(b.symbol) : a.type === 'INDEX' ? -1 : 1)).slice(0, limit);
}

module.exports = { load, resolve, contractKey, search, build, fnoList };
