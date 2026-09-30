// Date Picks: chuni hui date pe saare index + F&O stocks ke liye strategy ka BUY view.
// Har symbol: BUY CE / BUY PE (ya koi trade nahi), entry time + price, SL, Target 1/2,
// aur purani date ho to kya hua (target / SL / square-off).
const fs = require('fs');
const path = require('path');
const upstox = require('./upstox');
const instruments = require('./instruments');
const backtest = require('./backtest');
const strategy = require('./strategy');
const { istParts } = require('./indicators');
const { round2 } = require('./tradeEngine');
const HttpError = require('../utils/httpError');
const config = require('../config/env');
const riskService = require('./riskService');

const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'];
const CACHE = path.join(__dirname, '..', '..', 'data', 'candles');
const STRATS = {
  orb: { strategy: 'orb', orMinutes: 30, label: 'ORB 30 min' },
  trend: { strategy: 'trend', label: 'Trend (strict)' },
  // Scalping: 3 min candle, din me kai chhote trade, 15 min me T1 nahi to bahar
  scalp: { strategy: 'scalp', interval: 3, label: 'Momentum Scalp 3 min' },
  // Stop hunt (liquidity sweep) ke baad reversal
  sweep: { strategy: 'sweep', interval: 5, label: 'Liquidity Sweep (SMC) 5 min' },
};

const BEST_BEFORE = '11:00';
const addDays = (d, n) => upstox.istDate(new Date(`${d}T12:00:00+05:30`).getTime() + n * 86400000);

// 5m (ya iv) candles (date se kuch din pehle se, warm-up ke liye). Purani date = disk cache.
async function candlesFor(key, date, iv = 5) {
  const today = upstox.istDate(new Date());
  const f = path.join(CACHE, `${key.replace(/[^\w]/g, '_')}_${date}${iv === 5 ? '' : `_${iv}m`}.json`);
  if (date < today && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = await upstox.getCandles(key, { unit: 'minutes', interval: iv, from: addDays(date, -7), to: date });
  if (date < today && c.some((x) => upstox.istDate(x.time) === date)) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(c));
  }
  return c;
}

const RESULT = {
  TP2: 'Target 2 hit',
  TP1: 'Target 1 hit',
  SL: 'SL hit',
  TRAIL_SL: 'Target 1 ke baad cost pe bahar',
  EOD: '3:15 square-off',
  TIME: 'Time stop - move nahi aaya, bahar',
};

function outcome(t, running) {
  const reasons = t.exits.map((e) => e.reason);
  const last = t.exits[t.exits.length - 1];
  const hhmm = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  if (running && reasons.includes('EOD')) return { code: 'RUNNING', text: 'Abhi chal raha hai', time: null };
  let code = reasons.includes('TP2') ? 'TP2' : reasons.includes('SL') ? 'SL' : t.tp1Hit && reasons.includes('TRAIL_SL') ? 'TRAIL_SL' : t.tp1Hit ? 'TP1' : reasons.includes('TIME') ? 'TIME' : 'EOD';
  if (t.tp1Hit && code === 'EOD') code = 'TP1';
  return { code, text: RESULT[code], time: last ? hhmm(last.time) : null, tp1Time: t.tp1HitAt ? hhmm(t.tp1HitAt) : null };
}

// Signal kyun bana - har pass hue check ko aasaan bhasha me
function explain(sig, t, prm = {}, iv = 5) {
  const up = t.direction === 'LONG';
  const checks = (up ? sig.checks?.long : sig.checks?.short) || [];
  const all = [...checks, ...(sig.filters || [])].filter((c) => c.ok);
  const num = (s) => String(s || '').match(/-?[\d.]+/g) || [];
  const out = [];
  for (const c of all) {
    const n = c.name;
    const d = num(c.detail);
    if (/Liquidity sweep/.test(n)) out.push(`${c.detail}: bhav ne yahan ke stop-loss uda diye (stop hunt), phir wapas ${up ? 'upar' : 'neeche'} band hua`);
    else if (/Displacement/.test(n)) out.push(`Uske baad tez ${up ? 'green' : 'red'} candle (${c.detail}) → bade players ${up ? 'kharid' : 'bech'} rahe hain`);
    else if (/Structure shift/.test(n)) out.push(`Sweep candle ka ${up ? 'high' : 'low'} toota → trend ${up ? 'upar' : 'neeche'} palta (market structure shift)`);
    else if (/SL \(sweep ka wick\)/.test(n)) out.push(`SL sweep ke wick ke peeche (${c.detail}) → wahan tak aaya to stop hunt galat`);
    else if (/momentum breakout/.test(n)) out.push(`Pichhle kuch minute ka high (${d[d.length - 1]}) toda → buyers ka jhatka abhi shuru hua`);
    else if (/momentum breakdown/.test(n)) out.push(`Pichhle kuch minute ka low (${d[d.length - 1]}) toda → sellers ka jhatka abhi shuru hua`);
    else if (/Tez candle/.test(n)) out.push(`Candle normal se ${d[d.length - 1]}x badi → market me abhi speed hai`);
    else if (/exhausted/.test(n)) out.push(`RSI ${d[d.length - 1]} → momentum hai par move thaka nahi`);
    else if (/VWAP se .* ATR/.test(n)) out.push(`Bhav abhi zyada door nahi bhaga (${d[0]} ATR) → late entry nahi, chase nahi`);
    else if (/VWAP/.test(n)) {
      const vw = d.length > 1 ? d[1] : d[0];
      out.push(up ? `Bhav din ke average bhav (VWAP ${vw}) ke upar → aaj buyers haavi` : `Bhav din ke average bhav (VWAP ${vw}) ke neeche → aaj sellers haavi`);
    }
    else if (/^EMA/.test(n)) out.push(up ? `Chhota average EMA9 (${d[0]}) bade EMA21 (${d[1]}) ke upar → short-term trend upar` : `Chhota average EMA9 (${d[0]}) bade EMA21 (${d[1]}) ke neeche → short-term trend neeche`);
    else if (/Supertrend/.test(n)) out.push(up ? 'Supertrend hara (UP) → trend upar ka' : 'Supertrend laal (DOWN) → trend neeche ka');
    else if (/^RSI/.test(n)) out.push(up ? `RSI ${d[d.length - 1]} → momentum upar, par zyada overbought nahi` : `RSI ${d[d.length - 1]} → momentum neeche, par zyada oversold nahi`);
    else if (/prev high/.test(n)) out.push(`Candle ne pichhli candle ka high (${d[1]}) toda → upar breakout`);
    else if (/prev low/.test(n)) out.push(`Candle ne pichhli candle ka low (${d[1]}) toda → neeche breakdown`);
    else if (/ADX/.test(n)) out.push(`ADX ${d[0]} → trend me taakat hai, market sideways nahi`);
    else if (/Opening range \(\d+m\) bani/.test(n)) out.push(`Subah ki range bani: ${c.detail}`);
    else if (/OR high \(breakout\)|Opening range high/.test(n)) out.push(`Subah ki range ka high (${d[d.length - 1]}) toot ke upar close → buyers ne range todi`);
    else if (/OR low \(breakdown\)|Opening range low/.test(n)) out.push(`Subah ki range ka low (${d[d.length - 1]}) toot ke neeche close → sellers ne range todi`);
    else if (/fresh/.test(n)) out.push('Range pehli baar tooti (fresh breakout), baar-baar wala nahi');
    else if (/m trend/.test(n)) out.push(`15 min chart pe bhi trend ${up ? 'upar' : 'neeche'} → bade timeframe ka saath`);
    else if (/candle/.test(n)) out.push(`Signal candle mazboot (body ${d[d.length - 1]}%) → asli ${up ? 'kharidari' : 'bikwali'}, sirf wick nahi`);
    else out.push(`${n} (${c.detail})`);
  }
  out.push(`SL ${t.underlyingLevels.stopLoss}: bhav yahan aaya to andaza galat saabit → turant bahar`);
  out.push(`Target 1 = SL jitni doori (1:1), Target 2 = do guna. T1 pe SL cost pe le aao`);
  if (prm.timeStopBars > 0) out.push(`${prm.timeStopBars * iv} min me Target 1 nahi aaya to bina soche bahar → theta decay me paisa mat phasao`);
  return out;
}

// Entry ke waqt 3 flags (217 stocks x 3 mahine data me in teeno se loss kam hua):
// 1) NIFTY subah se trade ki taraf >0.2%  2) aaj ki 30m range >= pichhle 5 din ki avg  3) gap trade ki taraf 0.5% se zyada nahi
function entryFlags({ candles, date, t, market }) {
  const d = t.direction === 'LONG' ? 1 : -1;
  const byDay = new Map();
  for (const c of candles) {
    const p = istParts(c.time);
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push({ ...c, min: p.minutes });
  }
  const days = [...byDay.keys()].sort();
  const di = days.indexOf(date);
  const today = byDay.get(date) || [];
  const flags = [];

  // 1) NIFTY
  const mk = market || candles;
  const mDay = mk.filter((c) => istParts(c.time).day === date);
  const mAt = mDay.find((c) => ms(c.time) === ms(t.signalTime));
  if (mDay.length && mAt) {
    const pct = ((mAt.close - mDay[0].open) / mDay[0].open) * 100 * d;
    flags.push({ key: 'nifty', ok: pct > 0.2, text: pct > 0.2 ? `NIFTY subah se trade ki taraf (${pct.toFixed(2)}%)` : `NIFTY saath nahi (${pct.toFixed(2)}% trade ki taraf)` });
  }
  // 2) Range
  const orW = (list) => {
    const or = list.filter((c) => c.min < 585);
    return or.length >= 3 ? (Math.max(...or.map((c) => c.high)) - Math.min(...or.map((c) => c.low))) / or[0].open : null;
  };
  const now = orW(today);
  const prev = days.slice(Math.max(0, di - 5), di).map((k) => orW(byDay.get(k))).filter((x) => x != null);
  if (now != null && prev.length >= 3) {
    const rel = now / (prev.reduce((a, b) => a + b, 0) / prev.length);
    flags.push({ key: 'range', ok: rel >= 1, text: rel >= 1 ? `Aaj ki subah ki range chaudi (${rel.toFixed(1)}x normal) → market me jaan` : `Subah ki range patli (${rel.toFixed(1)}x normal) → fake breakout ka khatra` });
  }
  // 3) Gap
  if (di > 0 && today.length) {
    const prevDay = byDay.get(days[di - 1]);
    const pc = prevDay[prevDay.length - 1].close;
    const gap = ((today[0].open - pc) / pc) * 100 * d;
    flags.push({ key: 'gap', ok: gap <= 0.5, text: gap <= 0.5 ? `Gap trade ki taraf zyada nahi (${gap.toFixed(2)}%)` : `Gap pehle hi trade ki taraf (${gap.toFixed(2)}%) → move shayad ho chuka` });
  }
  return { flags, score: flags.filter((f) => f.ok).length, of: flags.length };
}

// Target / SL kyun hua - entry se exit tak kya badla
const ms = (x) => new Date(x).getTime();
function outcomeReasons({ candles, series, t, code, market, iv = 5 }) {
  if (code === 'RUNNING') return [];
  const d = t.direction === 'LONG' ? 1 : -1;
  const up = d === 1;
  const ei = candles.findIndex((c) => ms(c.time) === ms(t.entryTime));
  const lastExit = t.exits[t.exits.length - 1];
  let xi = lastExit ? candles.findIndex((c) => ms(c.time) === ms(lastExit.time)) : -1;
  if (ei < 0) return [];
  if (xi < ei) xi = ei;
  const path = candles.slice(ei, xi + 1);
  const mins = Math.round((ms(candles[xi].time) - ms(candles[ei].time)) / 60000) + iv;
  const x = candles[xi];
  const out = [];

  // 1) Market (NIFTY) ne saath diya ya nahi
  if (market) {
    const m0 = market.find((c) => ms(c.time) === ms(candles[ei].time));
    const m1 = market.find((c) => ms(c.time) === ms(x.time));
    if (m0 && m1) {
      const pct = ((m1.close - m0.open) / m0.open) * 100;
      const withUs = pct * d > 0.05;
      const against = pct * d < -0.05;
      out.push(
        withUs
          ? `NIFTY bhi saath chala (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%) → poora market trade ki taraf tha`
          : against
            ? `NIFTY ulti taraf chala (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%) → market ne saath nahi diya`
            : `NIFTY flat raha (${pct.toFixed(2)}%) → market ka koi zor nahi tha`
      );
    }
  }

  // 2) VWAP (din ka average) ke hisaab se kaun haavi raha
  const vwX = series.vwap[xi];
  if (vwX != null) {
    const onSide = (x.close - vwX) * d > 0;
    if (code === 'SL' && !onSide) out.push(`Bhav wapas VWAP (${round2(vwX)}) ke ${up ? 'neeche' : 'upar'} aa gaya → ${up ? 'buyers' : 'sellers'} kamzor pad gaye`);
    else if (code !== 'SL' && onSide) out.push(`Bhav poore time VWAP ke ${up ? 'upar' : 'neeche'} tika raha → ${up ? 'buyers' : 'sellers'} ka control bana raha`);
  }

  // 3) Trap: breakout level ke andar wapas aaya?
  const orLvl = up ? series.orHigh[ei] : series.orLow[ei];
  if (code === 'SL' && orLvl != null && path.some((c) => (c.close - orLvl) * d < 0)) {
    out.push(`Bhav wapas subah ki range (${round2(orLvl)}) ke andar aa gaya → breakout fake nikla (trap)`);
  }

  // 4) Trend palta (Supertrend)
  if (code === 'SL' && series.stDir[xi] != null && series.stDir[xi] !== d) out.push(`Supertrend palat ke ${up ? 'DOWN' : 'UP'} ho gaya → chhota trend badal gaya`);

  // 5) Speed / jhatka
  const atr = series.atr[ei] || 0;
  const adverse = Math.max(0, ...path.map((c) => (up ? c.open - c.low : c.high - c.open)));
  if (code === 'SL' && atr && adverse > 1.5 * atr) out.push(`Ek hi candle me ${round2(adverse)} pts ka ulta jhatka (normal se ${(adverse / atr).toFixed(1)}x) → bada order / news`);
  if (code === 'SL' && mins <= 3 * iv) out.push(`Entry ke sirf ${mins} min me SL → entry ke turant baad momentum khatam`);

  if (code === 'TP1' || code === 'TP2') {
    const withCandles = path.filter((c) => (c.close - c.open) * d > 0).length;
    out.push(`${path.length} me se ${withCandles} candles trade ki taraf band hui → lagatar ${up ? 'kharidari' : 'bikwali'}`);
    const tMin = code === 'TP1' && t.tp1HitAt ? Math.round((ms(t.tp1HitAt) - ms(candles[ei].time)) / 60000) + iv : mins;
    out.push(`Target ${code === 'TP1' ? '1 ' : ''}${tMin} min me aaya`);
  }
  if (code === 'TRAIL_SL') out.push('Target 1 tak gaya, phir momentum khatam → bhav wapas entry pe (SL cost pe tha, isliye nuksaan nahi)');
  if (code === 'TIME') out.push(`${mins} min me Target 1 nahi aaya → momentum ruk gaya, time stop pe bahar (option ka theta kha jaata)`);
  if (code === 'EOD') {
    const hi = Math.max(...path.map((c) => c.high));
    const lo = Math.min(...path.map((c) => c.low));
    out.push(`Din bhar na target na SL - bhav sirf ${round2(hi - lo)} pts ki range me ghooma (sideways)`);
  }
  return out;
}

// ---- Option premium (asli bhav) ----
// Contract: date ke baad wali nearest expiry (expiry ke din hi expire hone wala nahi - theta bahut tez), strike = ATM.
// Chalu expiry = instruments file, purani = Upstox expired-instruments API. Na mile to null (sirf index levels dikhenge).
const expiredCache = new Map(); // underlyingKey -> expiries[]

async function optionContract(info, date, type, strike) {
  const st = await instruments.load();
  const fo = st.bySymbol.get(info.symbol);
  const live = (fo?.options || []).filter((o) => o.expiry > date);
  const liveExp = [...new Set(live.map((o) => o.expiry))].sort();
  const exp = liveExp.find((e) => e > date);
  // Chalu contracts me date ke baad pehli expiry, par beech me koi expired expiry na chhooti ho
  let expired = expiredCache.get(info.underlyingKey);
  if (!expired) {
    try {
      expired = (await upstox.request('/v2/expired-instruments/expiries', { query: { instrument_key: info.underlyingKey } })) || [];
    } catch (err) {
      if (err.status === 424) throw err;
      expired = [];
    }
    expiredCache.set(info.underlyingKey, expired);
  }
  const oldExp = expired.filter((e) => e > date).sort()[0];
  if (exp && (!oldExp || exp <= oldExp)) {
    const c = live.find((o) => o.expiry === exp && o.type === type && o.strike === strike);
    return c ? { key: c.key, expiry: exp, expired: false } : null;
  }
  if (!oldExp) return null;
  const list = await upstox.request('/v2/expired-instruments/option/contract', { query: { instrument_key: info.underlyingKey, expiry_date: oldExp } });
  const c = (list || []).find((x) => x.instrument_type === type && x.strike_price === strike);
  return c ? { key: c.instrument_key, expiry: oldExp, expired: true } : null;
}

// Option ke candles (sirf us din ke), purani date disk cache
async function optionCandles(contract, date, iv) {
  const today = upstox.istDate(new Date());
  const f = path.join(CACHE, `opt_${contract.key.replace(/[^\w]/g, '_')}_${date}_${iv}m.json`);
  if (date < today && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  let c;
  if (contract.expired) {
    const r = await upstox.request(`/v2/expired-instruments/historical-candle/${encodeURIComponent(contract.key)}/${iv}minute/${date}/${date}`);
    c = (r?.candles || []).map(([time, open, high, low, close]) => ({ time, open, high, low, close })).reverse();
  } else {
    c = await upstox.getCandles(contract.key, { unit: 'minutes', interval: iv, from: date, to: date });
  }
  c = c.filter((x) => istParts(x.time).day === date);
  if (date < today && c.length) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(c));
  }
  return c;
}

// Option chart pe hi trade: buy entry candle ke open pe, SL / T1 (aadha book, SL cost) / T2 / time stop / 15:15.
// Candle me pehle SL check (pessimistic). Charges nahi.
function simulateOption(oc, ei, lv, prm, running) {
  const hhmm = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const squareOff = strategy.hhmmToMin(prm.squareOff);
  const book = prm.tp1BookAll || lv.target2 == null ? 1 : 0.5;
  let sl = lv.stopLoss;
  let open = 1;
  let pnl = 0;
  let t1 = null;
  let last = null;
  for (let k = ei, bars = 1; k < oc.length && open > 0; k++, bars++) {
    const c = oc[k];
    if (istParts(c.time).minutes >= squareOff) {
      pnl += open * (c.open - lv.entry);
      last = { code: t1 ? 'TP1' : 'EOD', time: c.time };
      open = 0;
      break;
    }
    if (c.low <= sl) {
      const px = Math.min(sl, c.open);
      pnl += open * (px - lv.entry);
      last = { code: t1 ? 'TRAIL_SL' : 'SL', time: c.time };
      open = 0;
      break;
    }
    if (!t1 && c.high >= lv.target1) {
      t1 = c.time;
      pnl += book * (lv.target1 - lv.entry);
      open -= book;
      sl = lv.entry;
      if (open <= 0) last = { code: 'TP1', time: c.time };
    }
    if (open > 0 && lv.target2 != null && t1 && c.high >= lv.target2) {
      pnl += open * (lv.target2 - lv.entry);
      open = 0;
      last = { code: 'TP2', time: c.time };
      break;
    }
    if (open > 0 && !t1 && prm.timeStopBars > 0 && bars >= prm.timeStopBars) {
      pnl += open * (c.close - lv.entry);
      open = 0;
      last = { code: 'TIME', time: c.time };
    }
  }
  if (open > 0) {
    if (running) return { code: 'RUNNING', text: RESULT_RUNNING, tp1Time: t1 ? hhmm(t1) : null, ltp: oc[oc.length - 1]?.close ?? null };
    const c = oc[oc.length - 1];
    pnl += open * (c.close - lv.entry);
    last = { code: t1 ? 'TP1' : 'EOD', time: c.time };
  }
  return { code: last.code, text: RESULT[last.code], time: hhmm(last.time), tp1Time: t1 ? hhmm(t1) : null, points: round2(pnl) };
}
const RESULT_RUNNING = 'Abhi chal raha hai';

// Jab index ka SL itna door ho ki premium SL ban hi na sake (ORB): exit index ke SL / target / time pe hi,
// aur us waqt option ka bhav (exit candle ka close) se P&L. t.exits = index backtest ke exits.
function optionFromIndex(oc, ei, t, idxOut, running) {
  const entry = oc[ei].open;
  let pnl = 0;
  let booked = 0;
  for (const e of t.exits) {
    let c = oc[ei];
    for (let k = ei; k < oc.length && ms(oc[k].time) <= ms(e.time); k++) c = oc[k];
    const frac = e.quantity / t.quantity;
    pnl += frac * (c.close - entry);
    booked += frac;
  }
  const open = 1 - booked;
  if (open > 1e-9) {
    const last = oc[oc.length - 1];
    if (running) return { code: 'RUNNING', text: RESULT_RUNNING, tp1Time: idxOut.tp1Time, ltp: last?.close ?? null };
    pnl += open * (last.close - entry);
  }
  return { code: idxOut.code, text: idxOut.text, time: idxOut.time, tp1Time: idxOut.tp1Time, points: round2(pnl), viaIndex: true };
}

// Pick ke liye option ka bhav: entry premium, SL / T1 / T2 premium (delta ~0.5 se), option chart pe result, abhi ka LTP
async function optionPremium({ info, symbol, date, t, strike, prm, iv, running, idxOut }) {
  const type = t.direction === 'LONG' ? 'CE' : 'PE';
  const contract = await optionContract(info, date, type, strike);
  if (!contract) return { error: 'Option contract nahi mila' };
  const oc = await optionCandles(contract, date, iv);
  // Kam trading wale option me entry candle na ho to agla candle (max 2 candle baad)
  const ei = oc.findIndex((c) => ms(c.time) >= ms(t.entryTime) && ms(c.time) - ms(t.entryTime) <= 2 * iv * 60000);
  if (ei < 0) return { expiry: contract.expiry, error: `${symbol} ${strike} ${type} me trading bahut kam (illiquid) - is option me scalp mat karo` };
  const delta = 0.5;
  const risk = delta * Math.abs(t.underlyingEntry - t.underlyingLevels.stopLoss);
  const entry = oc[ei].open;
  // Premium SL tabhi jab wo premium ke 30% se upar bane; warna (ORB jaisa door SL) exit index levels pe
  const viaIndex = risk >= 0.7 * entry;
  const lv = {
    entry,
    stopLoss: viaIndex ? null : tick(entry - risk),
    target1: tick(entry + risk * prm.tp1R),
    target2: prm.tp1BookAll || t.underlyingLevels.target2 == null ? null : tick(entry + risk * prm.tp2R),
  };
  const res = viaIndex ? optionFromIndex(oc, ei, t, idxOut, running) : simulateOption(oc, ei, lv, prm, running);
  // SL pe andaza loss: delta x index SL doori, par premium se zyada nahi
  const slMove = -Math.min(risk, entry);
  const lot = info.lotSize || 1;
  const amt = (x) => (x == null ? null : Math.round(x * lot));
  const out = {
    name: `${symbol} ${strike} ${type}`,
    expiry: contract.expiry,
    exchange: info.exchange || 'NSE',
    lotSize: lot,
    // 1 lot ke hisaab se paisa (UI lots se guna karta hai)
    perLot: {
      invest: amt(entry), // LTP x lot size
      slLoss: amt(slMove), // negative (viaIndex me andaza, max poora premium)
      t1Profit: amt(lv.target1 - entry), // poori qty T1 pe
      t2Profit: lv.target2 == null ? null : amt(lv.target2 - entry),
      // Plan: aadhi T1 pe, aadhi T2 pe (T2 na ho to sab T1 pe)
      planProfit: lv.target2 == null ? amt(lv.target1 - entry) : amt(0.5 * (lv.target1 - entry) + 0.5 * (lv.target2 - entry)),
    },
    instrumentKey: contract.key,
    viaIndex,
    indexSl: t.underlyingLevels.stopLoss,
    estSl: viaIndex ? tick(Math.max(entry - risk, 0.05)) : null,
    ...lv,
    result: res,
    pnlPerLot: res.points == null ? null : Math.round(res.points * lot),
  };
  if (running) {
    try {
      const l = await upstox.getLtp([contract.key]);
      out.ltp = l[contract.key] ?? res.ltp ?? null;
    } catch (err) {
      if (err.status === 424) throw err;
      out.ltp = res.ltp ?? null;
    }
  }
  return out;
}
const tick = (n) => Math.max(0.05, Math.round(n * 20) / 20);

async function pickFor(symbol, date, prm, running, market, iv = 5) {
  const info = await instruments.resolve(symbol);
  if (!info) return { symbol, error: 'symbol nahi mila' };
  const candles = await candlesFor(info.underlyingKey, date, iv);
  if (!candles.some((c) => istParts(c.time).day === date)) return { symbol, error: 'is din ka data nahi (holiday?)' };
  // Scalp: din ke saare trades, baaki strategies: din ka pehla trade
  const multi = prm.strategy === 'scalp';
  const r = backtest.run(candles, { ...prm, maxTradesPerDay: multi ? prm.maxTradesPerDay : 1, pauseLookback: 0 }, {
    mode: 'FUTURES',
    lots: 1,
    lotSize: info.lotSize || 1,
    brokeragePerOrder: 0,
    slippagePts: 0,
    tradeFrom: date,
  });
  const trades = r.trades.filter((x) => istParts(x.entryTime).day === date);
  const base = { symbol, type: info.type, lotSize: info.lotSize };
  if (!trades.length) {
    const sess = r.sessions.find((s) => s.day === date);
    return { ...base, signal: null, why: sess?.signals ? 'Signal aaya par time window ke bahar' : 'Aaj setup nahi bana' };
  }
  const series = strategy.computeIndicators(candles, prm);
  const mkt = symbol === 'NIFTY' ? null : market;
  return Promise.all(trades.map(async (t) => {
    // Signal candle pe checks dobara nikaalo (reasons ke liye)
    const si = candles.findIndex((c) => c.time === t.signalTime);
    const why = si > 0 ? explain(strategy.evaluateAt(candles, series, si, prm), t, prm, iv) : [];
    const d = t.direction === 'LONG' ? 1 : -1;
    const step = info.strikeStep || 50;
    const strike = Math.round(t.underlyingEntry / step) * step;
    const out = outcome(t, running);
    out.reasons = outcomeReasons({ candles, series, t, code: out.code, market: mkt, iv });
    const fl = entryFlags({ candles, date, t, market: mkt });
    const exitPx = t.exits.length ? t.exits.reduce((s, e) => s + e.price * e.quantity, 0) / t.exits.reduce((s, e) => s + e.quantity, 0) : null;
    const points = out.code === 'RUNNING' || exitPx == null ? null : round2((exitPx - t.entryPrice) * d);
    let premium = null;
    if (info.hasFno) {
      premium = await optionPremium({ info, symbol, date, t, strike, prm, iv, running: running && out.code === 'RUNNING', idxOut: out }).catch((err) => {
        if (err.status === 424) throw err;
        return { error: err.message };
      });
    }
    return {
      ...base,
      signal: t.direction === 'LONG' ? 'BUY CE' : 'BUY PE',
      option: `${symbol} ${strike} ${t.direction === 'LONG' ? 'CE' : 'PE'}`,
      time: new Date(t.entryTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }),
      entry: t.underlyingEntry,
      stopLoss: t.underlyingLevels.stopLoss,
      target1: t.underlyingLevels.target1,
      target2: t.underlyingLevels.target2,
      riskPts: round2(Math.abs(t.underlyingEntry - t.underlyingLevels.stopLoss)),
      timeStopMin: prm.timeStopBars > 0 ? prm.timeStopBars * iv : null,
      result: out,
      reasons: why,
      flags: fl.flags,
      flagScore: fl.score,
      flagOf: fl.of,
      allGreen: fl.of === 3 && fl.score === 3,
      points,
      // Option ka andaza: ATM delta ~0.5 -> premium move ~ aadha
      approxOptionPnlPerLot: points == null ? null : Math.round(points * 0.5 * (info.lotSize || 1)),
      // Option ka asli bhav: kis premium pe buy, SL / T1 / T2 premium me, option chart pe result, abhi ka LTP
      premium,
    };
  }));
}

async function picks({ date, universe = 'index', strat = 'orb' } = {}) {
  const today = upstox.istDate(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today;
  if (day > today) throw new HttpError(400, 'Future date nahi chal sakti');
  if (day < '2022-01-10') throw new HttpError(400, 'Data Jan 2022 se hai');
  const s = STRATS[strat] || STRATS.orb;
  const prm = strategy.withDefaults(s);
  const iv = s.interval || 5;
  const { minutes } = istParts(new Date());
  const running = day === today && minutes < 15 * 60 + 15;

  let symbols = [];
  if (universe === 'index' || universe === 'all') symbols.push(...INDICES);
  if (universe === 'stocks' || universe === 'all') symbols.push(...(await instruments.fnoList('STOCK')));
  symbols = [...new Set(symbols)];

  // NIFTY ke candles (market ne saath diya ya nahi - result ke kaaran ke liye)
  let market = null;
  try {
    const ni = await instruments.resolve('NIFTY');
    market = await candlesFor(ni.underlyingKey, day, iv);
  } catch (err) {
    if (err.status === 424) throw err;
  }

  const results = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = await Promise.all(
      symbols.slice(i, i + 3).map((sym) =>
        pickFor(sym, day, prm, running, market, iv).catch((err) => {
          if (err.status === 424) throw err;
          return { symbol: sym, error: err.message };
        })
      )
    );
    results.push(...batch.flat());
  }
  const withSignal = results.filter((r) => r.signal).sort((a, b) => (a.time < b.time ? -1 : 1));
  // BEST: sirf wo jo entry ke waqt hi pata chalte hain - teeno flags hare, option liquid, 11:00 se pehle.
  // ORB pe 60 din (Jul-Sep 2026, asli option bhav, charges ke baad): saare -1.05 lakh, BEST +41k (56 trades, 55% win)
  for (const p of withSignal) {
    const why = [];
    if (!p.allGreen) why.push(`${p.flagScore}/${p.flagOf} flags`);
    if (p.premium && p.premium.error) why.push('option illiquid / bhav nahi');
    if (p.time >= BEST_BEFORE) why.push(`${p.time} (11:00 ke baad)`);
    p.best = why.length === 0;
    p.notBestWhy = why;
  }
  const done = withSignal.filter((r) => r.result.code !== 'RUNNING');
  const green = withSignal.filter((r) => r.allGreen);
  const greenDone = green.filter((r) => r.result.code !== 'RUNNING');
  // Paise ka hisaab (lots suggest) ke liye capital rules
  let risk = null;
  try {
    const rules = await riskService.effectiveRules();
    risk = { capital: rules.capital, capitalFrom: rules.capitalFrom, riskPct: rules.riskPct, riskPerTrade: riskService.derived(rules).riskPerTrade };
  } catch {
    /* rules na mile to UI default lots 1 */
  }
  return {
    date: day,
    strategy: s.label,
    risk,
    brokeragePerOrder: config.rules.brokeragePerOrder,
    universe,
    running,
    summary: {
      scanned: results.length,
      signals: withSignal.length,
      target: done.filter((r) => ['TP1', 'TP2', 'TRAIL_SL'].includes(r.result.code)).length,
      sl: done.filter((r) => r.result.code === 'SL').length,
      timeStop: done.filter((r) => r.result.code === 'TIME').length,
      squareOff: done.filter((r) => r.result.code === 'EOD').length,
      green: green.length,
      greenTarget: greenDone.filter((r) => ['TP1', 'TP2', 'TRAIL_SL'].includes(r.result.code)).length,
      greenSl: greenDone.filter((r) => r.result.code === 'SL').length,
      best: withSignal.filter((r) => r.best).length,
    },
    // Din ka 1 trade: sabse pehla signal jisme teeno flags hare
    best: withSignal.find((x) => x.best) || null,
    picks: withSignal,
    noSignal: results.filter((r) => !r.signal && !r.error).map((r) => ({ symbol: r.symbol, why: r.why })),
    errors: results.filter((r) => r.error),
  };
}

module.exports = { picks, INDICES, simulateOption, optionFromIndex };
