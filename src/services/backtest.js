// Pure backtester: historical candles pe strategy chala ke trades simulate karta hai.
// SL/TP1/TP2/trail ka logic wahi tradeEngine use hota hai jo live trades pe chalta hai.
//
// Modes:
//  - FUTURES: underlying price pe hi trade (P&L = points x qty)
//  - OPTION : ATM option buy ka approximation, premium move = delta x underlying move.
//             Theta decay, IV change aur bid-ask spread model nahi hote -> real option P&L isse kharab ho sakta hai.

const engine = require('./tradeEngine');
const reports = require('./reportEngine');
const strategy = require('./strategy');
const { istParts } = require('./indicators');

const DEFAULT_OPTS = {
  mode: 'OPTION', // OPTION | FUTURES
  delta: 0.5, // ATM option delta (OPTION mode)
  lots: 1,
  lotSize: 1,
  strikeStep: 50,
  brokeragePerOrder: 20,
  slippagePts: 0, // har order pe underlying points ka slippage
  tp1ExitPercent: 50,
  moveSlToCostOnTp1: true,
  underlying: 'UNDERLYING',
};

// Underlying price -> trade price. Option premium = p0 +/- delta x (U - U0); PE ulta chalta hai.
// p0 sirf display ke liye realistic premium hai (~0.6% of spot), P&L sirf delta x move se aata hai.
function priceMap(mode, direction, delta, u0, p0) {
  if (mode === 'FUTURES') return (u) => u;
  if (direction === 'LONG') return (u) => p0 + delta * (u - u0);
  return (u) => p0 - delta * (u - u0);
}

function openTrade(sig, candle, p, o) {
  const d = sig.direction === 'LONG' ? 1 : -1;
  const u0 = candle.open;
  // Fixed SL level (ORB buffer) ho to entry (agle candle ka open) se wahi level; warna signal ka risk
  const fromLevel = sig.slLevel != null ? (u0 - sig.slLevel) * d : null;
  const risk = fromLevel != null && fromLevel > 0 ? fromLevel : sig.riskPts;
  const uLevels = {
    stopLoss: u0 - d * risk,
    target1: u0 + d * risk * p.tp1R,
    target2: p.tp1BookAll ? null : u0 + d * risk * p.tp2R,
  };
  // p0 itna bada ki SL / gap pe premium negative na ho
  const p0 = Math.max(u0 * 0.006, o.delta * risk * 4);
  const map = priceMap(o.mode, sig.direction, o.delta, u0, p0);
  const isOpt = o.mode === 'OPTION';
  const side = isOpt || sig.direction === 'LONG' ? 'BUY' : 'SELL';
  const r = engine.round2;
  const t = {
    underlying: o.underlying,
    instrumentType: 'INDEX',
    segment: isOpt ? 'OPT' : 'FUT',
    optionType: isOpt ? (sig.direction === 'LONG' ? 'CE' : 'PE') : null,
    strike: isOpt ? Math.round(u0 / o.strikeStep) * o.strikeStep : null,
    expiry: candle.time,
    side,
    lots: o.lots,
    lotSize: o.lotSize,
    entryPrice: r(map(u0)),
    entryTime: new Date(candle.time),
    stopLoss: r(map(uLevels.stopLoss)),
    target1: r(map(uLevels.target1)),
    target2: uLevels.target2 == null ? null : r(map(uLevels.target2)),
    strategy: 'Trend Confluence',
    direction: sig.direction,
    signalScore: sig.score,
    signalTime: sig.time, // jis candle pe signal bana (entry agle candle ke open pe)
    underlyingEntry: r(u0),
    underlyingLevels: { stopLoss: r(uLevels.stopLoss), target1: r(uLevels.target1), target2: uLevels.target2 == null ? null : r(uLevels.target2) },
  };
  engine.initTrade(t);
  const scale = isOpt ? o.delta : 1;
  // slippage (dono orders) + STT/exchange jaise variable charges (Upstox brokerage API se)
  t.extraCharges = r(o.slippagePts * scale * t.quantity * 2 + (o.variableChargesPerTrade || 0));
  engine.recompute(t, o);
  t._map = map;
  return t;
}

// Ek candle ko trade pe "replay" karo. Pessimistic order: pehle adverse extreme, phir favourable.
function feedCandle(t, c, o) {
  const m = t._map;
  const vals = [m(c.open), m(c.high), m(c.low), m(c.close)];
  const hi = Math.max(vals[1], vals[2]);
  const lo = Math.min(vals[1], vals[2]);
  const buy = t.side === 'BUY';
  const seq = buy ? [vals[0], lo, hi, vals[3]] : [vals[0], hi, lo, vals[3]];
  const events = [];
  for (let k = 0; k < seq.length && engine.isActive(t); k++) {
    let px = seq[k];
    const sl = t.stopLoss;
    // Open pe gap ho to wahi fill, warna SL level pe fill
    if (k > 0 && sl != null && (buy ? px <= sl : px >= sl)) px = sl;
    events.push(...engine.onPriceUpdate(t, engine.round2(Math.max(px, 0)), { ...o, time: new Date(c.time) }));
  }
  return events;
}

function closeAt(t, price, time, o, reason = 'EOD') {
  if (!engine.isActive(t)) return;
  engine.applyExit(t, { price: engine.round2(Math.max(t._map(price), 0)), reason, time: new Date(time) }, o);
}

// Kitne lots: o.riskPerTrade ho to SL hit pe (risk + slippage + charges) us limit ke andar, max o.lots.
// 0 = trade skip (1 lot bhi capital ke hisaab se bahut risky).
function sizeLots(sig, candle, p, o) {
  if (!o.riskPerTrade) return o.lots;
  const one = openTrade(sig, candle, p, { ...o, lots: 1 });
  const scale = o.mode === 'OPTION' ? o.delta : 1;
  const perLot = Math.abs(one.entryPrice - one.initialStopLoss) * one.lotSize + o.slippagePts * scale * one.lotSize * 2 + (o.variableChargesPerTrade || 0);
  const fixed = 2 * (o.brokeragePerOrder || 0);
  return Math.min(o.lots, Math.max(0, Math.floor((o.riskPerTrade - fixed) / perLot)));
}

// Auto-pause: pichhle N trades (paper bhi) ka net < 0 -> naya trade sirf paper
function isPaused(trades, n) {
  if (!n || trades.length < n) return false;
  return trades.slice(-n).reduce((s, t) => s + t.netPnl, 0) < 0;
}

function run(candles, params = {}, options = {}) {
  const p = strategy.withDefaults(params);
  const o = { ...DEFAULT_OPTS, ...options };
  const series = strategy.computeIndicators(candles, p);
  const squareOff = strategy.hhmmToMin(p.squareOff);

  const trades = [];
  let pos = null;
  let pending = null;
  let day = null;
  let tradesToday = 0;
  let lossesToday = 0;
  let signalsSeen = 0;
  const skipped = { window: 0, dailyLimit: 0, risk: 0, dayLoss: 0, monthLoss: 0 };
  // Capital rules (live jaisa): o.riskPerTrade, o.dailyLossLimit, o.monthlyLossLimit (Rs). Real trades ka P&L:
  let dayPnl = 0;
  const monthPnl = new Map();
  // o.tradeFrom (YYYY-MM-DD IST): isse pehle ke candles sirf indicators warm-up ke liye
  const sessions = []; // har trading din: { day, signals, skippedWindow, skippedLimit }
  let session = null;
  let firstIdx = null;

  const finish = (t) => {
    delete t._map;
    delete t._bars;
    trades.push(t);
    if (t.result === 'LOSS') lossesToday += 1;
    if (!t.paper) {
      dayPnl += t.netPnl;
      const m = istParts(t.entryTime).day.slice(0, 7);
      monthPnl.set(m, (monthPnl.get(m) || 0) + t.netPnl);
    }
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const { day: cDay, minutes } = istParts(c.time);
    if (cDay !== day) {
      // naya din: purani position (data gap) previous close pe band
      if (pos) {
        closeAt(pos, candles[i - 1].close, candles[i - 1].time, o);
        finish(pos);
        pos = null;
      }
      day = cDay;
      session = null;
      if (!o.tradeFrom || cDay >= o.tradeFrom) {
        session = { day: cDay, signals: 0, skippedWindow: 0, skippedLimit: 0, skippedRisk: 0, skippedLoss: 0 };
        sessions.push(session);
        if (firstIdx == null) firstIdx = i;
      }
      tradesToday = 0;
      lossesToday = 0;
      dayPnl = 0;
      pending = null;
    }

    if (!pos && pending) {
      if (minutes < squareOff) {
        const month = cDay.slice(0, 7);
        if (o.monthlyLossLimit && (monthPnl.get(month) || 0) <= -o.monthlyLossLimit) {
          skipped.monthLoss += 1;
          if (session) session.skippedLoss += 1;
        } else if (o.dailyLossLimit && dayPnl <= -o.dailyLossLimit) {
          skipped.dayLoss += 1;
          if (session) session.skippedLoss += 1;
        } else {
          const lots = sizeLots(pending, c, p, o);
          if (lots < 1) {
            skipped.risk += 1;
            if (session) session.skippedRisk += 1;
          } else {
            pos = openTrade(pending, c, p, { ...o, lots });
            pos._bars = 0;
            pos.paper = isPaused(trades, p.pauseLookback);
            tradesToday += 1;
          }
        }
      }
      pending = null;
    }

    if (pos) {
      if (minutes >= squareOff) closeAt(pos, c.open, c.time, o);
      else {
        feedCandle(pos, c, o);
        pos._bars += 1;
        // Time stop: itne candles me TP1 nahi aaya to candle close pe exit
        if (p.timeStopBars > 0 && engine.isActive(pos) && !pos.tp1Hit && pos._bars >= p.timeStopBars) closeAt(pos, c.close, c.time, o, 'TIME');
      }
      if (!engine.isActive(pos)) {
        finish(pos);
        pos = null;
      }
    }

    if (session && !pos && minutes < squareOff) {
      const sig = strategy.evaluateAt(candles, series, i, p);
      if (sig.direction && sig.fresh) {
        signalsSeen += 1;
        session.signals += 1;
        if (!sig.inWindow) {
          skipped.window += 1;
          session.skippedWindow += 1;
        } else if (tradesToday >= p.maxTradesPerDay || lossesToday >= p.maxLossesPerDay) {
          skipped.dailyLimit += 1;
          session.skippedLimit += 1;
        } else pending = sig;
      }
    }
  }
  if (pos) {
    const last = candles[candles.length - 1];
    closeAt(pos, last.close, last.time, o);
    finish(pos);
  }

  const tz = 'Asia/Kolkata';
  const real = trades.filter((t) => !t.paper);
  let equity = 0;
  const equityCurve = real.map((t) => {
    equity += t.netPnl;
    return { time: t.exitTime, equity: engine.round2(equity) };
  });

  return {
    params: p,
    options: { ...o },
    candles: candles.length,
    from: firstIdx != null ? candles[firstIdx].time : candles[0]?.time,
    to: candles[candles.length - 1]?.time,
    signalsSeen,
    skipped,
    sessions,
    paused: trades.length - real.length,
    // Abhi (aakhri candle ke baad) naya trade real hoga ya paper
    pauseState: {
      lookback: p.pauseLookback,
      recentNet: engine.round2(trades.slice(-p.pauseLookback || trades.length).reduce((s, t) => s + t.netPnl, 0)),
      recentTrades: Math.min(trades.length, p.pauseLookback || 0),
      paused: isPaused(trades, p.pauseLookback),
    },
    pausedNet: engine.round2(trades.filter((t) => t.paper).reduce((s, t) => s + t.netPnl, 0)),
    summary: reports.summarize(real),
    daily: reports.daily(real, tz),
    monthly: reports.monthly(real, tz),
    bySide: reports.bySide(real),
    equityCurve,
    trades,
  };
}

module.exports = { DEFAULT_OPTS, run, priceMap };
