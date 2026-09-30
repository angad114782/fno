// Pure rule-based intraday strategy ("Trend Confluence").
// Base: har closed candle pe 5 checks - VWAP, EMA cross, Supertrend, RSI zone, previous candle breakout.
// Strict mode me upar se filters (sab pass hone chahiye):
//   ADX (trend strength), opening range breakout, 15m trend same direction,
//   VWAP se zyada door nahi (chase nahi), strong signal candle.
// Signal "fresh" tab hai jab pichle candle pe qualify nahi karta tha.
// SL = ATR based, TP1/TP2 = R multiples. Levels underlying (spot/futures) price me hote hain.

const ind = require('./indicators');
const { round2 } = require('./tradeEngine');

const STRATEGIES = {
  trend: 'Trend Confluence (VWAP+EMA+Supertrend+RSI)',
  orb: 'Opening Range Breakout',
  pdhl: 'Pichhle din High/Low breakout',
  vwaprev: 'VWAP Mean Reversion',
  scalp: 'Momentum Scalp (3 min)',
  sweep: 'Liquidity Sweep (SMC)',
};

// Strategy ke apne defaults (DEFAULT_PARAMS ke upar, explicit params inke upar)
// Scalp: 3 min candle pe tez move pakdo, SL signal candle ke peeche (chhota), 5 candle (15 min) me T1 nahi = bahar (theta se bachav).
// Backtest (Jul-Sep 2026): 3 min, 1 min se behtar tha - 1 min pe trades zyada, charges saara gross kha jaate the.
const PRESETS = {
  // Liquidity sweep: stop hunt ke baad palat ke chalne wala move. SL sweep ke extreme ke peeche.
  sweep: {
    orMinutes: 15,
    tp1R: 1,
    tp2R: 2,
    timeStopBars: 8,
    entryStart: '09:30',
    entryEnd: '14:30',
    maxTradesPerDay: 2,
    maxLossesPerDay: 2,
    pauseLookback: 0,
  },
  scalp: {
    tp1R: 1,
    tp2R: 2,
    timeStopBars: 5,
    entryStart: '09:20',
    entryEnd: '14:45',
    maxTradesPerDay: 4,
    maxLossesPerDay: 2,
    pauseLookback: 0,
  },
};

const DEFAULT_PARAMS = {
  strategy: 'trend', // trend | orb | pdhl | vwaprev | scalp | sweep
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  atrPeriod: 14,
  stPeriod: 10,
  stMultiplier: 3,
  rsiLongMin: 55,
  rsiLongMax: 75,
  rsiShortMin: 25,
  rsiShortMax: 45,
  minScore: 4, // 5 me se kitne base checks pass hone chahiye
  slAtr: 1.5, // SL = entry -/+ slAtr * ATR
  tp1R: 1, // TP1 = 1R
  tp2R: 2, // TP2 = 2R
  entryStart: '09:30', // IST, isse pehle entry nahi (opening volatility)
  entryEnd: '14:30', // IST, iske baad nayi entry nahi
  squareOff: '15:15', // IST, intraday position yahan band
  maxTradesPerDay: 2, // overtrading control
  maxLossesPerDay: 2, // itne SL ke baad us din band

  // ---- Strict filters ----
  strict: true,
  adxMin: 20, // ADX isse kam = sideways market, trade nahi (0 = off)
  orFilter: true, // LONG sirf opening range high ke upar, SHORT low ke neeche
  orMinutes: 15, // opening range = 09:15 se itne minute
  htfFilter: true, // 15m supertrend bhi same direction me ho
  htfMinutes: 15,
  maxExtAtr: 1.5, // price VWAP se itne ATR se zyada door ho to chase nahi (0 = off)
  bodyMin: 0.5, // signal candle body / range (0 = off)

  // ---- Exits ----
  timeStopBars: 0, // itne candles me TP1 na aaye to exit (option theta se bachne ke liye, 0 = off)
  tp1BookAll: false, // TP1 pe poori qty book (1 lot ke liye useful)

  // ---- Auto-pause (equity curve filter) ----
  // Strategy ke pichhle N signals (real + paper) ka net loss me ho to naye trade sirf PAPER (real nahi).
  // Achha phase lautne pe apne aap real trades chalu. 0 = off
  pauseLookback: 10,

  // ---- VWAP reversion ----
  revAtr: 2, // price VWAP se kam se kam itne ATR door
  revRsi: 30, // LONG: RSI <= revRsi, SHORT: RSI >= 100 - revRsi

  // ORB SL: buffer = subah ki range ka doosra kinara (trap/wick se bachav, data me behtar) | atr = range size (0.5-2 ATR)
  orbSl: 'buffer',

  // ---- Momentum scalp (3 min) ----
  scalpLookback: 5, // close pichhli itni candles ke high/low ke paar (micro breakout)
  scalpRangeAtr: 1.2, // signal candle ki range >= itna x ATR (asli jhatka, normal candle nahi)
  scalpBody: 0.6, // body / range, trade ki taraf
  scalpRsiMax: 80, // LONG: RSI <= 80 (SHORT: >= 20) - bahut khinch chuka to chase nahi
  scalpSlMinAtr: 0.6, // SL = signal candle ka doosra kinara, par kam se kam itna ATR...
  scalpSlMaxAtr: 1.5, // ...aur zyada se zyada itna ATR

  // ---- Liquidity sweep (SMC) ----
  sweepLookback: 3, // sweep candle ke baad itni candles me displacement chahiye
  sweepSwing: 2, // swing high/low = dono taraf itni candles se upar/neeche (fractal)
  sweepMinAtr: 0.05, // wick level se kam se kam itna ATR paar (asli stop hunt)
  sweepDispAtr: 1, // displacement candle range >= itna ATR
  sweepBody: 0.55, // displacement candle body / range
  sweepMaxRiskAtr: 2.5, // SL (sweep extreme) itne ATR se door ho to skip
  sweepVwap: false, // entry VWAP ki sahi taraf ho (LONG: close > VWAP)
};

const hhmmToMin = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};

function withDefaults(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...(PRESETS[params.strategy] || {}) };
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const t = typeof DEFAULT_PARAMS[k];
    if (t === 'number') p[k] = Number(v);
    else if (t === 'boolean') p[k] = v === true || ['true', '1', 'on', 'yes'].includes(String(v).toLowerCase());
    else p[k] = v;
  }
  return p;
}

function computeIndicators(candles, params = {}) {
  const p = withDefaults(params);
  const closes = candles.map((c) => c.close);
  const st = ind.supertrend(candles, p.stPeriod, p.stMultiplier);
  const lv = ind.sessionLevels(candles, p.orMinutes);
  return {
    emaFast: ind.ema(closes, p.emaFast),
    emaSlow: ind.ema(closes, p.emaSlow),
    rsi: ind.rsi(closes, p.rsiPeriod),
    atr: ind.atr(candles, p.atrPeriod),
    vwap: ind.vwap(candles),
    stValue: st.value,
    stDir: st.dir,
    adx: ind.adx(candles, 14),
    htfDir: ind.htfSupertrendDir(candles, p.htfMinutes, p.stPeriod, p.stMultiplier),
    orHigh: lv.orHigh,
    orLow: lv.orLow,
    pdh: lv.pdh,
    pdl: lv.pdl,
    dayStart: dayStarts(candles),
  };
}

// Har candle ke din ki pehli candle ka index
function dayStarts(candles) {
  const out = new Array(candles.length);
  let day = null;
  let start = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = ind.istParts(candles[i].time).day;
    if (d !== day) {
      day = d;
      start = i;
    }
    out[i] = start;
  }
  return out;
}

// Candle j se pehle ki "liquidity": jahan stop-loss jama hote hain aur jo abhi tak toota nahi.
// Pichhle din ka high/low, subah ki range, aaj ke swing high/low (fractal). Returns { highs: [{name, lvl}], lows }
function liquidityPools(candles, s, j, p) {
  const d0 = s.dayStart[j];
  const k = p.sweepSwing;
  let maxH = -Infinity;
  let minL = Infinity;
  for (let m = d0; m < j; m++) {
    maxH = Math.max(maxH, candles[m].high);
    minL = Math.min(minL, candles[m].low);
  }
  const highs = [];
  const lows = [];
  // pichhle din ke levels: aaj abhi tak paar nahi hue
  if (s.pdh[j] != null && maxH < s.pdh[j]) highs.push({ name: 'Pichhle din ka high', lvl: s.pdh[j] });
  if (s.pdl[j] != null && minL > s.pdl[j]) lows.push({ name: 'Pichhle din ka low', lvl: s.pdl[j] });
  // subah ki range (poori bani ho, aur uske baad paar na hui ho)
  // (range j-1 tak poori bani ho; uske baad j se pehle paar na hui ho)
  if (j - 1 >= d0 && s.orHigh[j - 1] != null) {
    const H = s.orHigh[j - 1];
    const L = s.orLow[j - 1];
    let aboveH = false;
    let belowL = false;
    for (let m = d0 + 1; m < j; m++) {
      if (s.orHigh[m - 1] == null) continue; // range banne ke dauran wali candles nahi
      if (candles[m].high > H) aboveH = true;
      if (candles[m].low < L) belowL = true;
    }
    if (!aboveH) highs.push({ name: 'Subah ki range ka high', lvl: H });
    if (!belowL) lows.push({ name: 'Subah ki range ka low', lvl: L });
  }
  // aaj ke swing high/low jo abhi tak toote nahi (confirm: dono taraf k candles)
  for (let m = d0 + k; m <= j - 1 - k; m++) {
    const c = candles[m];
    let isH = true;
    let isL = true;
    for (let t = 1; t <= k; t++) {
      if (!(c.high > candles[m - t].high && c.high >= candles[m + t].high)) isH = false;
      if (!(c.low < candles[m - t].low && c.low <= candles[m + t].low)) isL = false;
    }
    if (isH || isL) {
      let brokeH = false;
      let brokeL = false;
      for (let t = m + 1; t < j; t++) {
        if (candles[t].high > c.high) brokeH = true;
        if (candles[t].low < c.low) brokeL = true;
      }
      if (isH && !brokeH) highs.push({ name: 'Swing high', lvl: c.high });
      if (isL && !brokeL) lows.push({ name: 'Swing low', lvl: c.low });
    }
  }
  return { highs, lows };
}

// Sweep: candle j ka wick pool ke paar gaya par close wapas andar (stop hunt).
// dir 1 = neeche wale stops (LONG setup), -1 = upar wale stops (SHORT setup)
function findSweep(candles, s, i, p, dir) {
  const atr = s.atr[i];
  const d0 = s.dayStart[i];
  for (let kk = 1; kk <= p.sweepLookback; kk++) {
    const j = i - kk;
    if (j < d0 + 1) break;
    const cj = candles[j];
    const pools = liquidityPools(candles, s, j, p);
    const list = dir === 1 ? pools.lows : pools.highs;
    // sabse bada (sabse door wala) pool jo sweep hua
    let best = null;
    for (const pl of list) {
      const swept = dir === 1 ? cj.low < pl.lvl - p.sweepMinAtr * atr && cj.close > pl.lvl : cj.high > pl.lvl + p.sweepMinAtr * atr && cj.close < pl.lvl;
      if (swept && (!best || (pl.lvl - best.lvl) * dir < 0)) best = pl;
    }
    if (!best) continue;
    // sweep ka extreme (j se i tak) - baad me naya extreme bana to sweep fail
    let ext = dir === 1 ? cj.low : cj.high;
    let failed = false;
    for (let t = j + 1; t <= i; t++) {
      if (dir === 1 ? candles[t].low < ext : candles[t].high > ext) failed = true;
    }
    if (failed) continue;
    // displacement se pehle koi candle already sweep candle ke paar close na hui ho (fresh MSS)
    let already = false;
    for (let t = j + 1; t < i; t++) {
      if (dir === 1 ? candles[t].close > cj.high : candles[t].close < cj.low) already = true;
    }
    if (already) continue;
    return { j, pool: best, ext, sweepCandle: cj };
  }
  return null;
}


const fmt = (n) => (n == null ? '-' : round2(n));

function checksAt(candles, s, i, p) {
  const c = candles[i];
  const prev = candles[i - 1];
  const long = [
    { name: 'Price > VWAP', ok: c.close > s.vwap[i], detail: `${fmt(c.close)} vs ${fmt(s.vwap[i])}` },
    { name: `EMA${p.emaFast} > EMA${p.emaSlow}`, ok: s.emaFast[i] > s.emaSlow[i], detail: `${fmt(s.emaFast[i])} vs ${fmt(s.emaSlow[i])}` },
    { name: 'Supertrend UP', ok: s.stDir[i] === 1, detail: `ST ${fmt(s.stValue[i])}` },
    { name: `RSI ${p.rsiLongMin}-${p.rsiLongMax}`, ok: s.rsi[i] >= p.rsiLongMin && s.rsi[i] <= p.rsiLongMax, detail: `RSI ${fmt(s.rsi[i])}` },
    { name: 'Close > prev high', ok: c.close > prev.high, detail: `${fmt(c.close)} vs ${fmt(prev.high)}` },
  ];
  const short = [
    { name: 'Price < VWAP', ok: c.close < s.vwap[i], detail: `${fmt(c.close)} vs ${fmt(s.vwap[i])}` },
    { name: `EMA${p.emaFast} < EMA${p.emaSlow}`, ok: s.emaFast[i] < s.emaSlow[i], detail: `${fmt(s.emaFast[i])} vs ${fmt(s.emaSlow[i])}` },
    { name: 'Supertrend DOWN', ok: s.stDir[i] === -1, detail: `ST ${fmt(s.stValue[i])}` },
    { name: `RSI ${p.rsiShortMin}-${p.rsiShortMax}`, ok: s.rsi[i] >= p.rsiShortMin && s.rsi[i] <= p.rsiShortMax, detail: `RSI ${fmt(s.rsi[i])}` },
    { name: 'Close < prev low', ok: c.close < prev.low, detail: `${fmt(c.close)} vs ${fmt(prev.low)}` },
  ];
  const score = (arr) => arr.filter((x) => x.ok).length;
  return { long, short, longScore: score(long), shortScore: score(short) };
}

// Strict filters for a direction. Returns [{ name, ok, detail }]
function filtersAt(candles, s, i, p, direction) {
  const c = candles[i];
  const d = direction === 'LONG' ? 1 : -1;
  const out = [];
  if (p.adxMin > 0) out.push({ name: `Trend strong (ADX ≥ ${p.adxMin})`, ok: s.adx[i] != null && s.adx[i] >= p.adxMin, detail: `ADX ${fmt(s.adx[i])}` });
  if (p.orFilter) {
    const lvl = d === 1 ? s.orHigh[i] : s.orLow[i];
    out.push({
      name: d === 1 ? `Opening range high (${p.orMinutes}m) ke upar` : `Opening range low (${p.orMinutes}m) ke neeche`,
      ok: lvl != null && (c.close - lvl) * d > 0,
      detail: lvl == null ? 'range abhi bani nahi' : `${fmt(c.close)} vs ${fmt(lvl)}`,
    });
  }
  if (p.htfFilter) {
    out.push({ name: `${p.htfMinutes}m trend bhi ${d === 1 ? 'UP' : 'DOWN'}`, ok: s.htfDir[i] === d, detail: s.htfDir[i] == null ? '-' : s.htfDir[i] === 1 ? 'UP' : 'DOWN' });
  }
  if (p.maxExtAtr > 0) {
    const ext = s.atr[i] ? Math.abs(c.close - s.vwap[i]) / s.atr[i] : 0;
    out.push({ name: `VWAP se ${p.maxExtAtr} ATR ke andar (chase nahi)`, ok: ext <= p.maxExtAtr, detail: `${fmt(ext)} ATR` });
  }
  if (p.bodyMin > 0) {
    const range = c.high - c.low;
    const body = (c.close - c.open) * d;
    const ratio = range > 0 ? body / range : 0;
    out.push({ name: `Strong ${d === 1 ? 'green' : 'red'} candle (body ≥ ${Math.round(p.bodyMin * 100)}%)`, ok: ratio >= p.bodyMin, detail: `${Math.round(ratio * 100)}%` });
  }
  return out;
}

const ready = (s, i) =>
  i > 0 && [s.emaFast, s.emaSlow, s.rsi, s.atr, s.vwap, s.stDir].every((arr) => arr[i] != null && arr[i - 1] != null);

// ---- Doosri strategies: har check pass = signal. riskPts strategy ke hisaab se ----
function altChecks(candles, s, i, p) {
  const c = candles[i];
  const pc = candles[i - 1].close;
  const atr = s.atr[i];
  if (p.strategy === 'orb') {
    const h = s.orHigh[i];
    const l = s.orLow[i];
    const range = h != null ? h - l : null;
    const riskPts = range != null ? Math.min(Math.max(range, 0.5 * atr), 2 * atr) : null;
    return {
      riskPts,
      orH: h,
      orL: l,
      long: [
        { name: `Opening range (${p.orMinutes}m) bani`, ok: h != null, detail: h != null ? `${fmt(l)} - ${fmt(h)}` : '-' },
        { name: 'Close > OR high (breakout)', ok: h != null && c.close > h, detail: `${fmt(c.close)} vs ${fmt(h)}` },
        { name: 'Pichhla close OR high ke andar (fresh)', ok: h != null && pc <= h, detail: fmt(pc) },
        { name: 'Price > VWAP', ok: c.close > s.vwap[i], detail: fmt(s.vwap[i]) },
      ],
      short: [
        { name: `Opening range (${p.orMinutes}m) bani`, ok: l != null, detail: l != null ? `${fmt(l)} - ${fmt(h)}` : '-' },
        { name: 'Close < OR low (breakdown)', ok: l != null && c.close < l, detail: `${fmt(c.close)} vs ${fmt(l)}` },
        { name: 'Pichhla close OR low ke andar (fresh)', ok: l != null && pc >= l, detail: fmt(pc) },
        { name: 'Price < VWAP', ok: c.close < s.vwap[i], detail: fmt(s.vwap[i]) },
      ],
    };
  }
  if (p.strategy === 'sweep') {
    const range = c.high - c.low;
    const bodyUp = range > 0 ? (c.close - c.open) / range : 0;
    const bodyDn = range > 0 ? (c.open - c.close) / range : 0;
    const rangeX = atr ? range / atr : 0;
    const build = (dir) => {
      const sw = findSweep(candles, s, i, p, dir);
      const up = dir === 1;
      const risk = sw ? (c.close - sw.ext) * dir + 0.1 * atr : null;
      const list = [
        {
          name: up ? 'Liquidity sweep: stops ke neeche wick, wapas upar close' : 'Liquidity sweep: stops ke upar wick, wapas neeche close',
          ok: Boolean(sw),
          detail: sw ? `${sw.pool.name} ${fmt(sw.pool.lvl)} (wick ${fmt(sw.ext)})` : '-',
        },
        {
          name: `Displacement: tez ${up ? 'green' : 'red'} candle (range ≥ ${p.sweepDispAtr} ATR, body ≥ ${Math.round(p.sweepBody * 100)}%)`,
          ok: rangeX >= p.sweepDispAtr && (up ? bodyUp : bodyDn) >= p.sweepBody,
          detail: `${fmt(rangeX)} ATR, body ${Math.round((up ? bodyUp : bodyDn) * 100)}%`,
        },
        {
          name: up ? 'Structure shift: close sweep candle ke high ke upar' : 'Structure shift: close sweep candle ke low ke neeche',
          ok: Boolean(sw) && (up ? c.close > sw.sweepCandle.high : c.close < sw.sweepCandle.low),
          detail: sw ? `${fmt(c.close)} vs ${fmt(up ? sw.sweepCandle.high : sw.sweepCandle.low)}` : '-',
        },
        {
          name: `SL (sweep ka wick) ${p.sweepMaxRiskAtr} ATR ke andar`,
          ok: risk != null && risk > 0 && risk <= p.sweepMaxRiskAtr * atr,
          detail: risk != null ? `${fmt(risk / atr)} ATR` : '-',
        },
      ];
      if (p.sweepVwap) list.push({ name: up ? 'Price > VWAP' : 'Price < VWAP', ok: (c.close - s.vwap[i]) * dir > 0, detail: fmt(s.vwap[i]) });
      return { list, risk, slLevel: sw ? sw.ext - dir * 0.1 * atr : null };
    };
    const L = build(1);
    const S = build(-1);
    return { riskLong: L.risk, riskShort: S.risk, slLong: L.slLevel, slShort: S.slLevel, long: L.list, short: S.list };
  }
  if (p.strategy === 'scalp') {
    const n = p.scalpLookback;
    const prevs = candles.slice(Math.max(0, i - n), i);
    const hh = prevs.length === n ? Math.max(...prevs.map((x) => x.high)) : null;
    const ll = prevs.length === n ? Math.min(...prevs.map((x) => x.low)) : null;
    const range = c.high - c.low;
    const rangeX = atr ? range / atr : 0;
    const bodyUp = range > 0 ? (c.close - c.open) / range : 0;
    const bodyDn = range > 0 ? (c.open - c.close) / range : 0;
    const buf = 0.1 * atr;
    const clampRisk = (x) => Math.min(Math.max(x, p.scalpSlMinAtr * atr), p.scalpSlMaxAtr * atr);
    const r = s.rsi[i];
    const out = {
      riskLong: clampRisk(c.close - c.low + buf),
      riskShort: clampRisk(c.high - c.close + buf),
      long: [
        { name: `Close > pichhli ${n} candles ka high (momentum breakout)`, ok: hh != null && c.close > hh, detail: `${fmt(c.close)} vs ${fmt(hh)}` },
        { name: `Tez candle (range ≥ ${p.scalpRangeAtr} ATR)`, ok: rangeX >= p.scalpRangeAtr, detail: `${fmt(rangeX)} ATR` },
        { name: `Strong green candle (body ≥ ${Math.round(p.scalpBody * 100)}%)`, ok: bodyUp >= p.scalpBody, detail: `${Math.round(bodyUp * 100)}%` },
        { name: `EMA${p.emaFast} > EMA${p.emaSlow}`, ok: s.emaFast[i] > s.emaSlow[i], detail: `${fmt(s.emaFast[i])} vs ${fmt(s.emaSlow[i])}` },
        { name: 'Price > VWAP', ok: c.close > s.vwap[i], detail: `${fmt(c.close)} vs ${fmt(s.vwap[i])}` },
        { name: `RSI 55-${p.scalpRsiMax} (momentum, exhausted nahi)`, ok: r >= 55 && r <= p.scalpRsiMax, detail: `RSI ${fmt(r)}` },
      ],
      short: [
        { name: `Close < pichhli ${n} candles ka low (momentum breakdown)`, ok: ll != null && c.close < ll, detail: `${fmt(c.close)} vs ${fmt(ll)}` },
        { name: `Tez candle (range ≥ ${p.scalpRangeAtr} ATR)`, ok: rangeX >= p.scalpRangeAtr, detail: `${fmt(rangeX)} ATR` },
        { name: `Strong red candle (body ≥ ${Math.round(p.scalpBody * 100)}%)`, ok: bodyDn >= p.scalpBody, detail: `${Math.round(bodyDn * 100)}%` },
        { name: `EMA${p.emaFast} < EMA${p.emaSlow}`, ok: s.emaFast[i] < s.emaSlow[i], detail: `${fmt(s.emaFast[i])} vs ${fmt(s.emaSlow[i])}` },
        { name: 'Price < VWAP', ok: c.close < s.vwap[i], detail: `${fmt(c.close)} vs ${fmt(s.vwap[i])}` },
        { name: `RSI ${100 - p.scalpRsiMax}-45 (momentum, exhausted nahi)`, ok: r >= 100 - p.scalpRsiMax && r <= 45, detail: `RSI ${fmt(r)}` },
      ],
    };
    return out;
  }
  if (p.strategy === 'pdhl') {
    const h = s.pdh[i];
    const l = s.pdl[i];
    return {
      riskPts: p.slAtr * atr,
      long: [
        { name: 'Close > pichhle din ka high', ok: h != null && c.close > h, detail: `${fmt(c.close)} vs ${fmt(h)}` },
        { name: 'Pichhla close PDH ke neeche (fresh)', ok: h != null && pc <= h, detail: fmt(pc) },
        { name: 'Price > VWAP', ok: c.close > s.vwap[i], detail: fmt(s.vwap[i]) },
      ],
      short: [
        { name: 'Close < pichhle din ka low', ok: l != null && c.close < l, detail: `${fmt(c.close)} vs ${fmt(l)}` },
        { name: 'Pichhla close PDL ke upar (fresh)', ok: l != null && pc >= l, detail: fmt(pc) },
        { name: 'Price < VWAP', ok: c.close < s.vwap[i], detail: fmt(s.vwap[i]) },
      ],
    };
  }
  // vwaprev
  const dist = atr ? (c.close - s.vwap[i]) / atr : 0;
  return {
    riskPts: p.slAtr * atr,
    long: [
      { name: `VWAP se ${p.revAtr}+ ATR neeche`, ok: dist <= -p.revAtr, detail: `${fmt(dist)} ATR` },
      { name: `RSI <= ${p.revRsi} (oversold)`, ok: s.rsi[i] <= p.revRsi, detail: `RSI ${fmt(s.rsi[i])}` },
      { name: 'Green reversal candle', ok: c.close > c.open, detail: '' },
      { name: 'Trend bahut strong nahi (ADX < 30)', ok: s.adx[i] == null || s.adx[i] < 30, detail: `ADX ${fmt(s.adx[i])}` },
    ],
    short: [
      { name: `VWAP se ${p.revAtr}+ ATR upar`, ok: dist >= p.revAtr, detail: `${fmt(dist)} ATR` },
      { name: `RSI >= ${100 - p.revRsi} (overbought)`, ok: s.rsi[i] >= 100 - p.revRsi, detail: `RSI ${fmt(s.rsi[i])}` },
      { name: 'Red reversal candle', ok: c.close < c.open, detail: '' },
      { name: 'Trend bahut strong nahi (ADX < 30)', ok: s.adx[i] == null || s.adx[i] < 30, detail: `ADX ${fmt(s.adx[i])}` },
    ],
  };
}

// Candle i pe kaunsi direction qualify karti hai (base score + strict filters)
function qualify(candles, s, i, p) {
  if (!ready(s, i)) return { direction: null };
  if (p.strategy !== 'trend') {
    const a = altChecks(candles, s, i, p);
    const all = (arr) => arr.every((x) => x.ok);
    const direction = all(a.long) ? 'LONG' : all(a.short) ? 'SHORT' : null;
    // ORB buffer SL: SL = range ka doosra kinara
    let slLevel = null;
    if (p.strategy === 'orb' && p.orbSl === 'buffer' && direction && a.orH != null) {
      slLevel = direction === 'LONG' ? a.orL : a.orH;
      a.riskPts = Math.abs(candles[i].close - slLevel);
    }
    if ((p.strategy === 'scalp' || p.strategy === 'sweep') && direction) a.riskPts = direction === 'LONG' ? a.riskLong : a.riskShort;
    if (p.strategy === 'sweep' && direction) slLevel = direction === 'LONG' ? a.slLong : a.slShort;
    const score = (arr) => arr.filter((x) => x.ok).length;
    return {
      ch: { long: a.long, short: a.short, longScore: score(a.long), shortScore: score(a.short) },
      candidate: direction,
      filters: [],
      direction: direction && a.riskPts > 0 ? direction : null,
      riskPts: a.riskPts,
      slLevel,
      maxScore: a.long.length,
    };
  }
  const ch = checksAt(candles, s, i, p);
  let direction = null;
  if (ch.longScore >= p.minScore && ch.longScore > ch.shortScore) direction = 'LONG';
  else if (ch.shortScore >= p.minScore && ch.shortScore > ch.longScore) direction = 'SHORT';
  const filters = direction && p.strict ? filtersAt(candles, s, i, p, direction) : [];
  const passed = filters.every((f) => f.ok);
  return { ch, candidate: direction, filters, direction: direction && passed ? direction : null, riskPts: p.slAtr * s.atr[i], maxScore: 5 };
}

/**
 * Candle i (closed) pe signal evaluate karo.
 * Returns { direction, fresh, score, checks, filters, entry, stopLoss, target1, target2, riskPts, atr, inWindow, reason }
 */
function evaluateAt(candles, series, i, params = {}) {
  const p = withDefaults(params);
  const c = candles[i];
  const base = { time: c.time, close: c.close, direction: null, fresh: false, score: 0, maxScore: 5, strict: p.strict && p.strategy === 'trend', strategy: p.strategy };
  if (!ready(series, i)) return { ...base, reason: 'Indicators warm-up (aur candles chahiye)' };

  const now = qualify(candles, series, i, p);
  const { minutes } = ind.istParts(c.time);
  const inWindow = minutes >= hhmmToMin(p.entryStart) && minutes <= hhmmToMin(p.entryEnd);

  const out = {
    ...base,
    maxScore: now.maxScore || 5,
    inWindow,
    atr: round2(series.atr[i]),
    rsi: round2(series.rsi[i]),
    adx: fmt(series.adx[i]),
    vwap: round2(series.vwap[i]),
    longScore: now.ch.longScore,
    shortScore: now.ch.shortScore,
    checks: { long: now.ch.long, short: now.ch.short },
    candidate: now.candidate,
    filters: now.filters,
  };
  if (!now.candidate) return { ...out, reason: 'Koi clear setup nahi (score kam hai)' };
  if (!now.direction) {
    const failed = now.filters.filter((f) => !f.ok).map((f) => f.name);
    return { ...out, reason: `${now.candidate} setup hai par strict filter fail: ${failed.join(', ')}` };
  }

  const prev = qualify(candles, series, i - 1, p);
  const fresh = prev.direction !== now.direction;
  const direction = now.direction;
  const d = direction === 'LONG' ? 1 : -1;
  const riskPts = now.riskPts;
  const slLevel = now.slLevel ?? null;
  const entry = c.close;
  return {
    ...out,
    direction,
    fresh,
    score: direction === 'LONG' ? now.ch.longScore : now.ch.shortScore,
    entry: round2(entry),
    stopLoss: round2(entry - d * riskPts),
    target1: round2(entry + d * riskPts * p.tp1R),
    target2: p.tp1BookAll ? null : round2(entry + d * riskPts * p.tp2R),
    riskPts: round2(riskPts),
    slLevel: slLevel != null ? round2(slLevel) : null,
    reason: !fresh ? 'Setup pehle se chal raha hai - chase mat karo, naye signal ka wait karo' : !inWindow ? 'Entry time window ke bahar' : 'Fresh signal',
  };
}

module.exports = { STRATEGIES, DEFAULT_PARAMS, PRESETS, withDefaults, computeIndicators, evaluateAt, hhmmToMin };
