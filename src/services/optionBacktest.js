// Real premium option backtester (expired option ka asli 5-min data).
// Day input: { day, expiry, index: [candle], leg(type, strike) -> [candle] | null }
// Candle: { t: 'HH:MM', o, h, l, c }  (IST)
//
// Setups:
//  - ironFly : entryTime pe ATM CE+PE SELL, ATM +/- wing BUY (hedge). Har short leg pe % SL.
//              Ek leg SL hone ke baad doosre ka SL cost pe (optional). exitTime pe sab band.
//  - buyOrb  : opening range breakout pe ATM option BUY (asli premium), premium % SL / target.

const { estimateCharges } = require('./brokerStats');

const r2 = (n) => Math.round(n * 100) / 100;
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const DEFAULTS = {
  setup: 'ironFly',
  entryTime: '09:20',
  exitTime: '15:15',
  wing: 300, // ironFly hedge distance (points)
  slPct: 30, // short leg SL = entry premium +30%
  slToCost: true, // ek leg SL ke baad doosre short leg ka SL = entry
  targetPct: 0, // net credit ka itna % profit aaye to sab band (0 = off)
  slMode: 'leg', // leg = har short leg ka % SL | combined = poori position ka loss credit ke combinedSlPct% pe (candle close)
  combinedSlPct: 50,
  onlyExpiryDay: false,
  skipExpiryDay: false,
  // buyOrb
  orMinutes: 30,
  buySlPct: 25,
  buyTargetPct: 50,
  lastEntry: '13:30',
  // common
  lots: 1,
  lotSize: 65,
  step: 50,
  brokeragePerOrder: 30,
};

function candleAt(candles, hhmm) {
  return candles.find((c) => c.t === hhmm) || null;
}
function between(candles, from, to) {
  const a = toMin(from);
  const b = toMin(to);
  return candles.filter((c) => toMin(c.t) >= a && toMin(c.t) < b);
}

function legCharges(buyAmount, sellAmount, brokeragePerOrder) {
  return estimateCharges({ trade_type: 'OPT', buy_amount: buyAmount, sell_amount: sellAmount }, brokeragePerOrder);
}

function ironFly(dayData, p) {
  const spotC = candleAt(dayData.index, p.entryTime);
  if (!spotC) return { skip: 'index candle nahi' };
  const atm = Math.round(spotC.o / p.step) * p.step;
  const qty = p.lots * p.lotSize;
  const spec = [
    { type: 'CE', strike: atm, side: 'SELL' },
    { type: 'PE', strike: atm, side: 'SELL' },
    { type: 'CE', strike: atm + p.wing, side: 'BUY' },
    { type: 'PE', strike: atm - p.wing, side: 'BUY' },
  ];
  const legs = [];
  for (const s of spec) {
    const cs = dayData.leg(s.type, s.strike);
    const e = cs && candleAt(cs, p.entryTime);
    if (!e) return { skip: `data nahi: ${s.type} ${s.strike}` };
    legs.push({ ...s, candles: between(cs, p.entryTime, '15:31'), entry: e.o, open: true });
  }
  const shorts = legs.filter((l) => l.side === 'SELL');
  for (const l of shorts) l.sl = r2(l.entry * (1 + p.slPct / 100));
  const credit = shorts.reduce((s, l) => s + l.entry, 0) - legs.filter((l) => l.side === 'BUY').reduce((s, l) => s + l.entry, 0);
  const events = [];
  const exitMin = toMin(p.exitTime);

  const close = (l, price, t, reason) => {
    l.exit = r2(price);
    l.exitT = t;
    l.reason = reason;
    l.open = false;
  };
  const priceAt = (l, t, field) => {
    const c = l.candles.find((x) => x.t === t);
    return c ? c[field] : null;
  };

  const times = [...new Set(legs[0].candles.map((c) => c.t))];
  for (const t of times) {
    if (toMin(t) >= exitMin) {
      for (const l of legs) if (l.open) close(l, priceAt(l, t, 'o') ?? l.candles.filter((c) => toMin(c.t) < toMin(t)).pop()?.c ?? l.entry, t, 'EXIT');
      break;
    }
    // short leg SL (gap ho to open pe, warna SL pe)
    for (const l of p.slMode === 'leg' ? shorts : []) {
      if (!l.open) continue;
      const c = l.candles.find((x) => x.t === t);
      if (!c) continue;
      if (c.o >= l.sl || c.h >= l.sl) {
        close(l, Math.max(c.o, l.sl), t, 'SL');
        events.push({ t, text: `${l.type} ${l.strike} SL hit @ ${l.exit}` });
        const wingLeg = legs.find((w) => w.side === 'BUY' && w.type === l.type && w.open);
        if (wingLeg) close(wingLeg, priceAt(wingLeg, t, 'c') ?? wingLeg.entry, t, 'HEDGE_EXIT');
        if (p.slToCost) {
          const other = shorts.find((o) => o.open);
          if (other && other.sl > other.entry) {
            other.sl = other.entry;
            events.push({ t, text: `${other.type} ${other.strike} SL cost (${other.entry}) pe` });
          }
        }
      }
    }
    // combined MTM (points per unit) - candle close pe
    if ((p.targetPct > 0 || p.slMode === 'combined') && legs.some((l) => l.open)) {
      let mtm = 0;
      for (const l of legs) {
        const px = l.open ? priceAt(l, t, 'c') ?? l.entry : l.exit;
        mtm += (l.side === 'SELL' ? l.entry - px : px - l.entry);
      }
      if (p.slMode === 'combined' && mtm <= -(credit * p.combinedSlPct) / 100) {
        for (const l of legs) if (l.open) close(l, priceAt(l, t, 'c') ?? l.entry, t, 'SL');
        events.push({ t, text: `Combined SL hit (loss ${p.combinedSlPct}% of credit)` });
        break;
      }
      if (p.targetPct > 0 && mtm >= (credit * p.targetPct) / 100) {
        for (const l of legs) if (l.open) close(l, priceAt(l, t, 'c') ?? l.entry, t, 'TARGET');
        events.push({ t, text: `Target hit (${p.targetPct}% of credit)` });
        break;
      }
    }
    if (!legs.some((l) => l.open)) break;
  }
  for (const l of legs) if (l.open) close(l, l.candles[l.candles.length - 1]?.c ?? l.entry, l.candles[l.candles.length - 1]?.t, 'EOD');

  let gross = 0;
  let charges = 0;
  for (const l of legs) {
    const pnl = (l.side === 'SELL' ? l.entry - l.exit : l.exit - l.entry) * qty;
    l.pnl = r2(pnl);
    gross += pnl;
    const buyAmt = (l.side === 'BUY' ? l.entry : l.exit) * qty;
    const sellAmt = (l.side === 'SELL' ? l.entry : l.exit) * qty;
    charges += legCharges(buyAmt, sellAmt, p.brokeragePerOrder);
  }
  return {
    setup: 'ironFly',
    day: dayData.day,
    expiry: dayData.expiry,
    spot: spotC.o,
    atm,
    credit: r2(credit),
    qty,
    legs: legs.map(({ candles, open, ...l }) => l),
    events,
    gross: r2(gross),
    charges: r2(charges),
    net: r2(gross - charges),
  };
}

// Opening range breakout -> ATM option BUY at next candle open, premium % SL/target
function buyOrb(dayData, p) {
  const idx = dayData.index;
  const orEnd = toMin('09:15') + p.orMinutes;
  const orC = idx.filter((c) => toMin(c.t) < orEnd);
  if (orC.length < p.orMinutes / 5) return { skip: 'opening range data nahi' };
  const hi = Math.max(...orC.map((c) => c.h));
  const lo = Math.min(...orC.map((c) => c.l));
  const after = idx.filter((c) => toMin(c.t) >= orEnd && toMin(c.t) <= toMin(p.lastEntry));
  let sig = null;
  for (let i = 0; i < after.length; i++) {
    if (after[i].c > hi) sig = { dir: 'CE', i };
    else if (after[i].c < lo) sig = { dir: 'PE', i };
    if (sig) break;
  }
  if (!sig) return { skip: 'breakout nahi hua' };
  const entryC = idx[idx.indexOf(after[sig.i]) + 1];
  if (!entryC) return { skip: 'entry candle nahi' };
  const atm = Math.round(entryC.o / p.step) * p.step;
  const cs = dayData.leg(sig.dir, atm);
  const e = cs && candleAt(cs, entryC.t);
  if (!e) return { skip: `data nahi: ${sig.dir} ${atm}` };
  const qty = p.lots * p.lotSize;
  const sl = r2(e.o * (1 - p.buySlPct / 100));
  const tgt = r2(e.o * (1 + p.buyTargetPct / 100));
  let exit = null;
  for (const c of between(cs, entryC.t, '15:31')) {
    if (toMin(c.t) >= toMin(p.exitTime)) {
      exit = { price: c.o, t: c.t, reason: 'EXIT' };
      break;
    }
    if (c.o <= sl || c.l <= sl) {
      exit = { price: Math.min(c.o, sl), t: c.t, reason: 'SL' };
      break;
    }
    if (c.h >= tgt) {
      exit = { price: Math.max(c.o, tgt), t: c.t, reason: 'TARGET' };
      break;
    }
  }
  if (!exit) {
    const last = cs[cs.length - 1];
    exit = { price: last.c, t: last.t, reason: 'EOD' };
  }
  const gross = (exit.price - e.o) * qty;
  const charges = legCharges(e.o * qty, exit.price * qty, p.brokeragePerOrder);
  return {
    setup: 'buyOrb',
    day: dayData.day,
    expiry: dayData.expiry,
    spot: entryC.o,
    atm,
    qty,
    legs: [{ type: sig.dir, strike: atm, side: 'BUY', entry: e.o, exit: r2(exit.price), exitT: exit.t, entryT: entryC.t, reason: exit.reason, sl, target: tgt }],
    events: [{ t: entryC.t, text: `ORB ${sig.dir === 'CE' ? 'upar' : 'neeche'} breakout, BUY ${sig.dir} ${atm} @ ${e.o}` }, { t: exit.t, text: `${exit.reason} @ ${r2(exit.price)}` }],
    gross: r2(gross),
    charges: r2(charges),
    net: r2(gross - charges),
  };
}

function stats(trades) {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sw = wins.reduce((s, t) => s + t.net, 0);
  const sl = -losses.reduce((s, t) => s + t.net, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    eq += t.net;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    streak = t.net <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const months = new Map();
  for (const t of trades) months.set(t.day.slice(0, 7), (months.get(t.day.slice(0, 7)) || 0) + t.net);
  const mv = [...months.values()];
  return {
    trades: trades.length,
    winRate: trades.length ? r2((100 * wins.length) / trades.length) : 0,
    net: r2(sw - sl),
    avgPerTrade: trades.length ? r2((sw - sl) / trades.length) : 0,
    avgWin: wins.length ? r2(sw / wins.length) : 0,
    avgLoss: losses.length ? r2(-sl / losses.length) : 0,
    profitFactor: sl ? r2(sw / sl) : null,
    maxDrawdown: r2(dd),
    maxLossStreak: maxStreak,
    worstDay: trades.length ? r2(Math.min(...trades.map((t) => t.net))) : 0,
    bestDay: trades.length ? r2(Math.max(...trades.map((t) => t.net))) : 0,
    months: mv.length,
    greenMonths: mv.filter((v) => v > 0).length,
    monthly: [...months].map(([month, net]) => ({ month, net: r2(net) })),
  };
}

function run(days, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const fn = p.setup === 'buyOrb' ? buyOrb : ironFly;
  const trades = [];
  const skipped = [];
  for (const d of days) {
    if (p.onlyExpiryDay && d.day !== d.expiry) continue;
    if (p.skipExpiryDay && d.day === d.expiry) {
      skipped.push({ day: d.day, reason: 'expiry day' });
      continue;
    }
    const r = fn(d, p);
    if (r.skip) skipped.push({ day: d.day, reason: r.skip });
    else trades.push(r);
  }
  return { params: p, summary: stats(trades), trades, skipped };
}

module.exports = { DEFAULTS, run, ironFly, buyOrb, stats };
