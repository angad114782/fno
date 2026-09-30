const test = require('node:test');
const assert = require('node:assert/strict');
const ind = require('../src/services/indicators');
const strategy = require('../src/services/strategy');
const backtest = require('../src/services/backtest');

// Purana (non-strict) logic, auto-pause off
const CLASSIC = { strict: false, pauseLookback: 0 };

// 5-min candles for IST session days (09:15 - 15:25), close path from fn(dayIdx, barIdx)
function makeCandles(days, pathFn, { volume = 1000 } = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const start = Date.UTC(2026, 8, 21 + d, 3, 45); // 09:15 IST
    for (let b = 0; b < 75; b++) {
      const close = pathFn(d, b);
      const open = b === 0 && out.length ? out[out.length - 1].close : out.length ? out[out.length - 1].close : close;
      out.push({
        time: new Date(start + b * 5 * 60000).toISOString(),
        open,
        high: Math.max(open, close) + 2,
        low: Math.min(open, close) - 2,
        close,
        volume,
      });
    }
  }
  return out;
}

test('ema / sma / rsi basics', () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(ind.sma(vals, 3).slice(0, 4), [null, null, 2, 3]);
  const e = ind.ema(vals, 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
  const r = ind.rsi(vals, 5);
  assert.equal(r[4], null);
  assert.equal(r[5], 100); // only gains
});

test('istParts converts to IST', () => {
  const p = ind.istParts('2026-09-21T03:45:00Z');
  assert.equal(p.day, '2026-09-21');
  assert.equal(p.minutes, 9 * 60 + 15);
});

test('vwap resets each day and falls back to avg price when no volume', () => {
  const c = makeCandles(2, (d, b) => 100 + d * 50 + b * 0, { volume: 0 });
  const v = ind.vwap(c);
  assert.ok(Math.abs(v[74] - 100) < 1e-9);
  const c75 = c[75];
  assert.equal(v[75], (c75.high + c75.low + c75.close) / 3); // new day resets
});

test('supertrend flips with trend', () => {
  const up = makeCandles(1, (d, b) => 1000 + b * 5);
  const st = ind.supertrend(up, 10, 3);
  assert.equal(st.dir[74], 1);
  const down = makeCandles(1, (d, b) => 2000 - b * 5);
  assert.equal(ind.supertrend(down, 10, 3).dir[74], -1);
});

test('strategy gives LONG in uptrend after sideways, SHORT in downtrend', () => {
  // sideways first ~half day then strong trend up
  const c = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 + (b - 35) * 6));
  const s = strategy.computeIndicators(c, CLASSIC);
  let found = null;
  for (let i = 1; i < c.length; i++) {
    const sig = strategy.evaluateAt(c, s, i, CLASSIC);
    if (sig.direction && sig.fresh) {
      found = sig;
      break;
    }
  }
  assert.ok(found, 'expected a fresh signal');
  assert.equal(found.direction, 'LONG');
  assert.ok(found.stopLoss < found.entry && found.entry < found.target1 && found.target1 < found.target2);

  const c2 = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 - (b - 35) * 6));
  const s2 = strategy.computeIndicators(c2, CLASSIC);
  const sigs = c2.map((_, i) => (i ? strategy.evaluateAt(c2, s2, i, CLASSIC) : null)).filter((x) => x && x.direction && x.fresh);
  assert.equal(sigs[0].direction, 'SHORT');
  assert.ok(sigs[0].stopLoss > sigs[0].entry);
});

test('backtest: trend day produces profitable trade, respects square-off and limits', () => {
  const c = makeCandles(3, (d, b) => (b < 35 ? 1000 + d * 10 + (b % 2) * 3 : 1000 + d * 10 + (b - 35) * 6));
  const r = backtest.run(c, CLASSIC, { mode: 'FUTURES', lotSize: 50, lots: 1, brokeragePerOrder: 0 });
  assert.ok(r.trades.length >= 1);
  assert.ok(r.trades.length <= 3 * strategy.DEFAULT_PARAMS.maxTradesPerDay);
  for (const t of r.trades) {
    assert.equal(t.status, 'CLOSED');
    const exitMin = ind.istParts(t.exitTime).minutes;
    assert.ok(exitMin <= 15 * 60 + 15, 'exit before/at square-off');
  }
  assert.ok(r.summary.netPnl > 0, `expected profit, got ${r.summary.netPnl}`);
  assert.equal(r.equityCurve.length, r.trades.length);
});

test('backtest OPTION mode: PE premium rises when underlying falls', () => {
  const c = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 - (b - 35) * 6));
  const r = backtest.run(c, CLASSIC, { mode: 'OPTION', delta: 0.5, lotSize: 50, brokeragePerOrder: 0 });
  const t = r.trades[0];
  assert.equal(t.optionType, 'PE');
  assert.equal(t.side, 'BUY');
  assert.ok(t.grossPnl > 0);
});

test('backtest SL hit books loss at SL level (no gap)', () => {
  // trend up triggers long, then sharp reversal
  const c = makeCandles(1, (d, b) => {
    if (b < 35) return 1000 + (b % 2) * 3;
    if (b < 37) return 1000 + (b - 35) * 6;
    return 1012 - (b - 37) * 15;
  });
  const r = backtest.run(c, { ...CLASSIC, maxTradesPerDay: 1 }, { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0 });
  const t = r.trades[0];
  assert.ok(t.slHit);
  assert.deepEqual(t.exits.map((e) => e.reason), ['SL']);
  assert.equal(t.exits[0].price, t.initialStopLoss); // SL level pe fill, candle low pe nahi
  assert.equal(t.result, 'LOSS');
});

test('backtest tradeFrom: warm-up days se trade nahi, sessions sirf tradeFrom se', () => {
  const c = makeCandles(3, (d, b) => (b < 35 ? 1000 + d * 10 + (b % 2) * 3 : 1000 + d * 10 + (b - 35) * 6));
  const r = backtest.run(c, CLASSIC, { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0, tradeFrom: '2026-09-23' });
  assert.deepEqual(r.sessions.map((s) => s.day), ['2026-09-23']);
  assert.ok(r.trades.length >= 1);
  for (const t of r.trades) assert.equal(ind.istParts(t.entryTime).day, '2026-09-23');
  // warm-up ki wajah se pehle hi candle se indicators ready -> signal 09:30 window me aa sakta hai
  assert.ok(r.sessions[0].signals >= 1);
});

test('ADX: trend me high, sideways me low', () => {
  const up = makeCandles(1, (d, b) => 1000 + b * 5);
  const side = makeCandles(1, (d, b) => 1000 + ((b % 4) - 1.5) * 4);
  assert.ok(ind.adx(up)[74] > 40);
  assert.ok(ind.adx(side)[74] < 20);
});

test('no lookahead: opening range, prev day levels, 15m trend sirf past data se', () => {
  const c = makeCandles(3, (d, b) => 1000 + Math.sin(b / 5) * 20 + b * (d === 1 ? 2 : -1));
  const lv = ind.sessionLevels(c, 15);
  const htf = ind.htfSupertrendDir(c, 15);
  // 5m candles: 09:15, 09:20, 09:25 -> OR 09:25 wale candle ke close (09:30) pe ready
  assert.equal(lv.orHigh[75 + 1], null);
  assert.ok(lv.orHigh[75 + 2] != null);
  assert.equal(lv.pdh[75], Math.max(...c.slice(0, 75).map((x) => x.high)));
  for (const i of [20, 80, 81, 82, 83, 150, 200, 224]) {
    const cut = c.slice(0, i + 1);
    assert.equal(ind.sessionLevels(cut, 15).orHigh[i], lv.orHigh[i], `orHigh @${i}`);
    assert.equal(ind.htfSupertrendDir(cut, 15)[i], htf[i], `htf @${i}`);
  }
});

test('strict: filters signal ko block karte hain aur reason batate hain', () => {
  // Uptrend but price opening range ke andar nahi -> ORB fail hona chahiye kahin na kahin
  const c = makeCandles(2, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 + (b - 35) * 6));
  const s = strategy.computeIndicators(c, { strict: true });
  const evals = c.map((_, i) => (i ? strategy.evaluateAt(c, s, i, { strict: true }) : null)).filter(Boolean);
  const blocked = evals.find((e) => e.candidate && !e.direction);
  assert.ok(blocked, 'expected a blocked candidate');
  assert.match(blocked.reason, /strict filter fail/);
  assert.ok(blocked.filters.some((f) => !f.ok));
  const passed = evals.find((e) => e.direction);
  if (passed) assert.ok(passed.filters.every((f) => f.ok));
});

test('auto-pause: pichhle N trades ka net < 0 ho to trade paper, summary me shamil nahi', () => {
  const c = makeCandles(8, (d, b) => {
    if (b < 35) return 1000 + (b % 2) * 3;
    if (b < 37) return 1000 + (b - 35) * 6; // fake breakout
    if (b < 45) return 1012 - (b - 37) * 6; // reversal -> SL
    return Math.min(1000, 964 + (b - 45) * 2);
  });
  const N = 2;
  const r = backtest.run(c, { ...CLASSIC, maxTradesPerDay: 1, entryEnd: '12:20', pauseLookback: N }, { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0 });
  assert.ok(r.paused >= 1);
  r.trades.forEach((t, k) => {
    const expected = k >= N && r.trades.slice(k - N, k).reduce((s2, x) => s2 + x.netPnl, 0) < 0;
    assert.equal(Boolean(t.paper), expected, `trade ${k}`);
  });
  assert.equal(r.summary.closed, r.trades.length - r.paused);
});

test('time stop aur TP1 full book', () => {
  // long signal ke baad flat -> time stop
  const flat = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : b < 38 ? 1000 + (b - 35) * 6 : 1008)); // T1 (~1016) aur SL (~995) ke beech atka
  const r = backtest.run(flat, { ...CLASSIC, timeStopBars: 3, maxTradesPerDay: 1 }, { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0 });
  assert.ok(r.trades[0].exits.some((e) => e.reason === 'TIME'));

  const trend = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 + (b - 35) * 6));
  const r2 = backtest.run(trend, { ...CLASSIC, tp1BookAll: true, maxTradesPerDay: 1 }, { mode: 'FUTURES', lotSize: 50, lots: 1, brokeragePerOrder: 0 });
  const t = r2.trades[0];
  assert.equal(t.target2, null);
  assert.deepEqual(t.exits.map((e) => e.reason), ['TP1']);
  assert.equal(t.exits[0].quantity, 50);
});

test('ORB: opening range ke upar pehla close = LONG, SL range se', () => {
  // 09:15-09:30 range, phir breakout
  const c = makeCandles(2, (d, b) => {
    if (d === 0) return 1000 + (b % 2) * 3; // warm-up din
    if (b < 3) return [1000, 1003, 998][b];
    if (b < 9) return 1000 + (b % 2) * 2;
    return 1000 + (b - 8) * 4;
  });
  const p = { strategy: 'orb', orMinutes: 15, pauseLookback: 0 };
  const s = strategy.computeIndicators(c, p);
  const sig = c.map((_, i) => (i ? strategy.evaluateAt(c, s, i, p) : null)).find((x) => x && x.direction && x.fresh && ind.istParts(x.time).day === '2026-09-22');
  assert.ok(sig, 'ORB signal expected');
  assert.equal(sig.direction, 'LONG');
  assert.equal(sig.maxScore, 4);
  assert.ok(sig.close > s.orHigh[c.findIndex((x) => x.time === sig.time)]);
  assert.ok(sig.riskPts > 0 && sig.stopLoss < sig.entry);
});

test('capital rules: 1 lot ka risk limit se zyada ho to skip, kaafi ho to trade', () => {
  const c = makeCandles(1, (d, b) => (b < 35 ? 1000 + (b % 2) * 3 : 1000 + (b - 35) * 6));
  const base = { mode: 'FUTURES', lotSize: 50, lots: 3, brokeragePerOrder: 20 };
  const tight = backtest.run(c, CLASSIC, { ...base, riskPerTrade: 100 }); // SL ~10 pts x 50 = 500 > 100
  assert.equal(tight.trades.length, 0);
  assert.ok(tight.skipped.risk >= 1);
  assert.ok(tight.sessions[0].skippedRisk >= 1);
  const ok = backtest.run(c, CLASSIC, { ...base, riskPerTrade: 1300 });
  assert.ok(ok.trades.length >= 1);
  const t = ok.trades[0];
  const loss = (t.entryPrice - t.initialStopLoss) * t.quantity + 2 * 20;
  assert.ok(loss <= 1300, `SL loss ${loss} limit ke andar`);
  assert.ok(t.lots >= 1 && t.lots <= 3);
});

test('ORB buffer SL: LONG ka SL subah ki range ka low, backtest entry se wahi level', () => {
  const c = makeCandles(2, (d, b) => {
    if (d === 0) return 1000 + (b % 2) * 3;
    if (b < 3) return [1000, 1003, 998][b];
    if (b < 9) return 1000 + (b % 2) * 2;
    return 1000 + (b - 8) * 4;
  });
  const p = { strategy: 'orb', orMinutes: 30, pauseLookback: 0 };
  const s = strategy.computeIndicators(c, p);
  const sig = c.map((_, i) => (i ? strategy.evaluateAt(c, s, i, p) : null)).find((x) => x && x.direction && x.fresh && ind.istParts(x.time).day === '2026-09-22');
  assert.ok(sig);
  const i = c.findIndex((x) => x.time === sig.time);
  assert.equal(sig.slLevel, s.orLow[i]);
  assert.equal(sig.stopLoss, s.orLow[i]);
  const r = backtest.run(c, { ...p, maxTradesPerDay: 1 }, { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0, tradeFrom: '2026-09-22' });
  assert.equal(r.trades[0].underlyingLevels.stopLoss, s.orLow[i]);
  const atr = strategy.evaluateAt(c, strategy.computeIndicators(c, { ...p, orbSl: 'atr' }), i, { ...p, orbSl: 'atr' });
  assert.equal(atr.slLevel, null);
});

// 1-min candles (strategy timeframe se independent): sideways drift (EMA/VWAP ke liye halka uptrend), phir ek bada green jhatka
function makeScalpCandles({ stall = true } = {}) {
  const out = [];
  const start = Date.UTC(2026, 8, 22, 3, 45); // 09:15 IST
  let px = 1000;
  for (let b = 0; b < 120; b++) {
    const open = px;
    let close = open + (b % 2 ? -0.9 : 1); // chhoti candles, halka upar
    if (b === 60) close = open + 6; // momentum candle (~10:15)
    if (b > 60) close = stall ? open + (b % 2 ? 0.5 : -0.5) : open + 4;
    px = close;
    out.push({ time: new Date(start + b * 60000).toISOString(), open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close, volume: 0 });
  }
  return out;
}

test('Scalp: momentum candle pe LONG, SL chhota (candle ke peeche), preset time stop', () => {
  const c = makeScalpCandles();
  const p = strategy.withDefaults({ strategy: 'scalp' });
  assert.equal(p.timeStopBars, 5);
  assert.equal(p.entryStart, '09:20');
  const s = strategy.computeIndicators(c, p);
  const sig = strategy.evaluateAt(c, s, 60, p);
  assert.equal(sig.direction, 'LONG');
  assert.ok(sig.fresh);
  assert.equal(sig.maxScore, 6);
  const atr = s.atr[60];
  assert.ok(sig.riskPts >= 0.6 * atr - 1e-9 && sig.riskPts <= 1.5 * atr + 1e-9, 'SL ATR ke 0.6-1.5x me');
  assert.ok(sig.riskPts < 6, 'SL signal candle ki range se chhota');
  // Normal chhoti candle pe signal nahi
  assert.equal(strategy.evaluateAt(c, s, 50, p).direction, null);
});

test('Scalp backtest: move ruk gaya to 5 candle baad TIME exit, chalta raha to target', () => {
  const opts = { mode: 'FUTURES', lotSize: 50, brokeragePerOrder: 0 };
  const stalled = backtest.run(makeScalpCandles({ stall: true }), { strategy: 'scalp' }, opts);
  assert.equal(stalled.trades.length, 1);
  assert.deepEqual(stalled.trades[0].exits.map((e) => e.reason), ['TIME']);
  const mins = (new Date(stalled.trades[0].exits[0].time) - new Date(stalled.trades[0].entryTime)) / 60000;
  assert.equal(mins, 4); // entry candle + 4 = 5 candles

  const running = backtest.run(makeScalpCandles({ stall: false }), { strategy: 'scalp' }, opts);
  assert.ok(running.trades[0].tp1Hit);
  assert.ok(running.trades[0].exits.some((e) => e.reason === 'TP2'));
});

test('Liquidity sweep: swing low ke neeche wick + wapas upar close, phir tez green candle = LONG, SL wick ke peeche', () => {
  const start = Date.UTC(2026, 8, 22, 3, 45);
  const rows = [];
  // 09:15 se: range, 09:45 ke aas-paas swing low 995, phir wick 990 (close 997), phir displacement
  for (let b = 0; b < 40; b++) {
    let o = 1000 + (b % 2 ? 1 : -1);
    let c = 1000 + (b % 2 ? -1 : 1);
    let h = Math.max(o, c) + 0.5;
    let l = Math.min(o, c) - 0.5;
    if (b === 8) l = 995; // swing low (liquidity)
    if (b === 30) { o = 999; c = 997; h = 999.5; l = 990; } // sweep: 995 ke neeche wick, close upar
    if (b === 31) { o = 997; c = 1003; h = 1003.5; l = 996.5; } // displacement + structure shift
    rows.push({ time: new Date(start + b * 5 * 60000).toISOString(), open: o, high: h, low: l, close: c, volume: 0 });
  }
  const prev = Array.from({ length: 75 }, (_, b) => ({ time: new Date(start - 86400000 + b * 5 * 60000).toISOString(), open: 1000, high: 1010, low: 985, close: 1000, volume: 0 }));
  const c = [...prev, ...rows];
  const p = strategy.withDefaults({ strategy: 'sweep' });
  const s = strategy.computeIndicators(c, p);
  const i = 75 + 31;
  const sig = strategy.evaluateAt(c, s, i, p);
  assert.equal(sig.direction, 'LONG', sig.reason);
  assert.match(sig.checks.long[0].detail, /Swing low 995/);
  assert.ok(sig.slLevel < 990 && sig.slLevel > 989, `SL wick ke peeche: ${sig.slLevel}`);
  assert.equal(strategy.evaluateAt(c, s, 75 + 20, p).direction, null);
});
