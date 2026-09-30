// Pure technical indicators. Input: candles [{ time, open, high, low, close, volume }] (oldest first).
// Har function candles jitni lambi array return karta hai; warm-up tak value null hoti hai.

const IST_OFFSET_MIN = 330;

// IST date key (YYYY-MM-DD) and minutes since midnight IST
function istParts(time) {
  const d = new Date(new Date(time).getTime() + IST_OFFSET_MIN * 60000);
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  const calc = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = calc();
  }
  return out;
}

function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

// Wilder's ATR
function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let prev = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Session VWAP (IST day wise reset). Index ka volume 0 hota hai -> tab session ka average typical price.
function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null;
  let pv = 0;
  let vol = 0;
  let tpSum = 0;
  let n = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = istParts(c.time).day;
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
      tpSum = 0;
      n = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += tp * v;
    vol += v;
    tpSum += tp;
    n += 1;
    out[i] = vol > 0 ? pv / vol : tpSum / n;
  }
  return out;
}

// Supertrend: returns { value[], dir[] } where dir 1 = up (bullish), -1 = down
function supertrend(candles, period = 10, multiplier = 3) {
  const a = atr(candles, period);
  const value = new Array(candles.length).fill(null);
  const dirs = new Array(candles.length).fill(null);
  let upper = null;
  let lower = null;
  let d = 1;
  for (let i = 0; i < candles.length; i++) {
    if (a[i] == null) continue;
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * a[i];
    const basicLower = hl2 - multiplier * a[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    upper = upper == null || basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = lower == null || basicLower > lower || prevClose < lower ? basicLower : lower;
    if (dirs[i - 1] == null) d = c.close >= hl2 ? 1 : -1;
    else if (d === 1 && c.close < lower) d = -1;
    else if (d === -1 && c.close > upper) d = 1;
    dirs[i] = d;
    value[i] = d === 1 ? lower : upper;
  }
  return { value, dir: dirs };
}

// Wilder's ADX (trend strength, direction se independent). > 20-25 = trending, < 20 = sideways
function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period * 2) return out;
  const tr = trueRange(candles);
  let trS = 0;
  let pS = 0;
  let mS = 0;
  const dx = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      trS += tr[i];
      pS += pdm;
      mS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pdm;
      mS = mS - mS / period + mdm;
    }
    const pdi = trS ? (100 * pS) / trS : 0;
    const mdi = trS ? (100 * mS) / trS : 0;
    dx[i] = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  let prev = null;
  for (let i = period; i < n; i++) {
    if (i < period * 2 - 1) continue;
    if (prev == null) {
      let s = 0;
      for (let k = period; k < period * 2; k++) s += dx[k];
      prev = s / period;
    } else prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Candle interval (minutes) - same din ke consecutive candles ka sabse chhota gap
function inferInterval(candles) {
  let best = Infinity;
  for (let i = 1; i < Math.min(candles.length, 200); i++) {
    const d = (new Date(candles[i].time) - new Date(candles[i - 1].time)) / 60000;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 5;
}

// Session levels: opening range (pehle orMinutes) + previous day high/low/close.
// Opening range sirf tab milta hai jab range complete ho chuki ho (lookahead nahi).
function sessionLevels(candles, orMinutes = 15) {
  const n = candles.length;
  const iv = inferInterval(candles);
  const orHigh = new Array(n).fill(null);
  const orLow = new Array(n).fill(null);
  const pdh = new Array(n).fill(null);
  const pdl = new Array(n).fill(null);
  const pdc = new Array(n).fill(null);
  const orEnd = 555 + orMinutes; // 09:15 + orMinutes
  let day = null;
  let hi = -Infinity;
  let lo = Infinity;
  let dayHi = -Infinity;
  let dayLo = Infinity;
  let lastClose = null;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const p = istParts(c.time);
    if (p.day !== day) {
      if (day != null) prev = { high: dayHi, low: dayLo, close: lastClose };
      day = p.day;
      hi = -Infinity;
      lo = Infinity;
      dayHi = -Infinity;
      dayLo = Infinity;
    }
    dayHi = Math.max(dayHi, c.high);
    dayLo = Math.min(dayLo, c.low);
    lastClose = c.close;
    if (p.minutes < orEnd) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    if (p.minutes + iv >= orEnd && hi > -Infinity) {
      orHigh[i] = hi;
      orLow[i] = lo;
    }
    if (prev) {
      pdh[i] = prev.high;
      pdl[i] = prev.low;
      pdc[i] = prev.close;
    }
  }
  return { orHigh, orLow, pdh, pdl, pdc };
}

// Higher timeframe (e.g. 15m) supertrend direction base candles pe.
// Candle i ke close pe sirf wahi HTF candle use hota hai jo complete ho chuka (lookahead nahi).
function htfSupertrendDir(candles, htfMinutes = 15, period = 10, multiplier = 3) {
  const n = candles.length;
  const iv = inferInterval(candles);
  const out = new Array(n).fill(null);
  const htf = [];
  const bucketOf = new Array(n);
  let key = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const p = istParts(c.time);
    const k = `${p.day}|${Math.floor((p.minutes - 555) / htfMinutes)}`;
    if (k !== key) {
      key = k;
      htf.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      const h = htf[htf.length - 1];
      h.high = Math.max(h.high, c.high);
      h.low = Math.min(h.low, c.low);
      h.close = c.close;
    }
    bucketOf[i] = htf.length - 1;
  }
  const dir = supertrend(htf, period, multiplier).dir;
  for (let i = 0; i < n; i++) {
    const p = istParts(candles[i].time);
    const closesBucket = (p.minutes + iv - 555) % htfMinutes === 0;
    const b = closesBucket ? bucketOf[i] : bucketOf[i] - 1;
    out[i] = b >= 0 ? dir[b] : null;
  }
  return out;
}

module.exports = { istParts, inferInterval, sma, ema, rsi, atr, trueRange, vwap, supertrend, adx, sessionLevels, htfSupertrendDir };
