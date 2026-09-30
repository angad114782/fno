// Real option premium data loader (Upstox expired-instruments API + disk cache).
// Returns days for optionBacktest: { day, expiry, index: [{t,o,h,l,c}], leg(type, strike) }
const fs = require('fs');
const path = require('path');
const upstox = require('./upstox');
const instruments = require('./instruments');
const HttpError = require('../utils/httpError');

const CACHE = path.join(__dirname, '..', '..', 'data', 'options');
const SYMBOLS = {
  // wingSteps: ATM se kitne strike door tak data (hedge/wing ke liye)
  NIFTY: { key: 'NSE_INDEX|Nifty 50', step: 50, wingSteps: 6 },
  SENSEX: { key: 'BSE_INDEX|SENSEX', step: 100, wingSteps: 10 },
  BANKNIFTY: { key: 'NSE_INDEX|Nifty Bank', step: 100, wingSteps: 6 },
  FINNIFTY: { key: 'NSE_INDEX|Nifty Fin Service', step: 50, wingSteps: 6 },
  MIDCPNIFTY: { key: 'NSE_INDEX|NIFTY MID SELECT', step: 25, wingSteps: 10 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
};

async function req(p, opts, tries = 5) {
  for (let t = 0; ; t++) {
    try {
      await sleep(300);
      return await upstox.request(p, opts);
    } catch (e) {
      if (e.status === 424 || t >= tries - 1) throw e;
      await sleep(/Too Many/.test(e.message) ? 20000 * (t + 1) : 1200 * (t + 1));
    }
  }
}

const toCandle = (x) => ({ t: x[0].slice(11, 16), o: x[1], h: x[2], l: x[3], c: x[4] });

/**
 * days for [from, to]. strikes: har din entry ATM ke aas-paas (CE -4..+8 step, PE -8..+4 step).
 * onProgress(msg) optional.
 */
async function loadDays(symbol, from, to, { onProgress } = {}) {
  const sym = String(symbol).toUpperCase();
  const cfg = SYMBOLS[sym];
  if (!cfg) throw new HttpError(400, `Asli option backtest abhi ${Object.keys(SYMBOLS).join(', ')} ke liye hai`);
  const dir = path.join(CACHE, sym);
  const today = upstox.istDate(new Date());

  // Index 5m (warm-up nahi chahiye, sirf range)
  const idx = await upstox.getCandles(cfg.key, { unit: 'minutes', interval: 5, from, to });
  const byDay = new Map();
  for (const c of idx) {
    const d = c.time.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ t: c.time.slice(11, 16), o: c.open, h: c.high, l: c.low, c: c.close });
  }
  const dayList = [...byDay.keys()].sort();
  if (!dayList.length) return [];

  // Expiries: expired (API) + current (instrument file)
  const expFile = path.join(dir, 'expiries.json');
  let expired = readJson(expFile, null);
  if (!expired || expired[expired.length - 1] < dayList[dayList.length - 1]) {
    expired = await req('/v2/expired-instruments/expiries', { query: { instrument_key: cfg.key } });
    writeJson(expFile, expired);
  }
  const info = await instruments.resolve(sym);
  const live = info?.expiries || [];
  const allExp = [...new Set([...expired, ...live])].sort();

  const days = [];
  const groups = new Map(); // expiry -> [day]
  for (const d of dayList) {
    const e = allExp.find((x) => x >= d);
    if (!e) continue;
    if (!groups.has(e)) groups.set(e, []);
    groups.get(e).push(d);
  }

  let n = 0;
  for (const [expiry, eDays] of groups) {
    n += 1;
    onProgress?.(`${expiry} (${n}/${groups.size})`);
    const eDir = path.join(dir, expiry);
    const isExpired = expiry < today && expired.includes(expiry);
    // contracts: strike/type -> key
    const cFile = path.join(eDir, 'contracts.json');
    let contracts = readJson(cFile, null);
    if (!contracts) {
      if (isExpired) {
        const list = await req('/v2/expired-instruments/option/contract', { query: { instrument_key: cfg.key, expiry_date: expiry } });
        contracts = list.map((c) => ({ k: c.instrument_key, s: c.strike_price, t: c.instrument_type }));
      } else {
        const st = await instruments.load();
        const fo = st.bySymbol.get(sym);
        contracts = (fo?.options || []).filter((o) => o.expiry === expiry).map((o) => ({ k: o.key, s: o.strike, t: o.type }));
      }
      if (isExpired) writeJson(cFile, contracts); // live expiry ka cache mat karo (strikes badal sakte)
    }
    const want = new Set();
    for (const d of eDays) {
      const first = byDay.get(d)[0];
      const a = Math.round(first.c / cfg.step) * cfg.step;
      for (let k = -2; k <= cfg.wingSteps; k++) want.add(`CE_${a + k * cfg.step}`);
      for (let k = -cfg.wingSteps; k <= 2; k++) want.add(`PE_${a + k * cfg.step}`);
    }
    const need = contracts.filter((c) => want.has(`${c.t}_${c.s}`));
    const legData = new Map();
    const fetchOne = async (c) => {
      const f = path.join(eDir, `${c.t}_${c.s}.json`);
      let rows = isExpired ? readJson(f, null) : null;
      if (!rows) {
        try {
          if (isExpired) {
            const r = await req(`/v2/expired-instruments/historical-candle/${encodeURIComponent(c.k)}/5minute/${expiry}/${eDays[0]}`);
            rows = (r?.candles || []).map((x) => [x[0].slice(0, 16), x[1], x[2], x[3], x[4]]).reverse();
            writeJson(f, rows);
          } else {
            const cs = await upstox.getCandles(c.k, { unit: 'minutes', interval: 5, from: eDays[0], to: eDays[eDays.length - 1] });
            rows = cs.map((x) => [x.time.slice(0, 16), x.open, x.high, x.low, x.close]);
          }
        } catch (err) {
          if (err.status === 424) throw err;
          rows = []; // cache nahi karte - agli baar dobara try
        }
      }
      legData.set(`${c.t}_${c.s}`, rows);
    };
    for (let i = 0; i < need.length; i += 2) await Promise.all(need.slice(i, i + 2).map(fetchOne));

    for (const d of eDays) {
      const cache = new Map();
      days.push({
        day: d,
        expiry,
        index: byDay.get(d),
        leg(type, strike) {
          const k = `${type}_${strike}`;
          if (!cache.has(k)) cache.set(k, (legData.get(k) || []).filter((x) => x[0].startsWith(d)).map(toCandle));
          const v = cache.get(k);
          return v.length ? v : null;
        },
      });
    }
  }
  return days;
}

module.exports = { loadDays, SYMBOLS };
