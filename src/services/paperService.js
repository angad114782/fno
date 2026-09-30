// Paper trading tracker: har trading din ka "⭐ pehla signal" record + hisaab.
const PaperTrade = require('../models/PaperTrade');
const picksService = require('./picksService');
const autoDefaults = require('./autoDefaults');
const upstox = require('./upstox');
const { istParts } = require('./indicators');
const { round2 } = require('./tradeEngine');
const HttpError = require('../utils/httpError');

const DEFAULT_CHARGES = 90; // 1 lot round trip (Upstox brokerage API se ~₹89)
const chargesCache = new Map();

async function roundTripCharges(symbol) {
  if (chargesCache.has(symbol)) return chargesCache.get(symbol);
  let v = DEFAULT_CHARGES;
  try {
    const a = await autoDefaults.forSymbol(symbol, 1);
    if (a.source === 'upstox') v = a.charges.roundTrip;
  } catch {
    /* default */
  }
  chargesCache.set(symbol, v);
  return v;
}

// Ek din record karo (pehle se ho to update)
async function recordDay(day, { universe = 'index', strat = 'orb' } = {}) {
  const r = await picksService.picks({ date: day, universe, strat });
  if (r.running) throw new HttpError(400, 'Aaj ka market abhi chal raha hai - 3:15 ke baad record hoga');
  const holiday = r.errors.length === r.summary.scanned;
  if (holiday) return null; // market band tha (holiday) - record nahi
  // Sirf wahi trade jisme teeno flags hare (NIFTY saath, range chaudi, gap saath nahi)
  const p = r.best;
  const doc = { day, universe, strat };
  if (!p) {
    const reason = r.picks.length ? `${r.picks.length} signal the, par kisi me teeno flags hare nahi - skip` : 'Is din koi setup nahi bana';
    Object.assign(doc, { noTrade: true, reason, netPnl: 0, grossPnl: 0, charges: 0, symbol: null, signal: null, result: null, points: null });
  } else {
    const gross = p.approxOptionPnlPerLot ?? 0;
    const charges = await roundTripCharges(p.symbol);
    Object.assign(doc, {
      noTrade: false,
      reason: null,
      symbol: p.symbol,
      signal: p.signal,
      option: p.option,
      time: p.time,
      entry: p.entry,
      stopLoss: p.stopLoss,
      target1: p.target1,
      target2: p.target2,
      lotSize: p.lotSize,
      result: p.result,
      flags: p.flags,
      points: p.points,
      grossPnl: gross,
      charges: round2(charges),
      netPnl: round2(gross - charges),
    });
  }
  return PaperTrade.findOneAndUpdate({ day, universe, strat }, doc, { upsert: true, new: true });
}

const addDays = (d, n) => upstox.istDate(new Date(`${d}T12:00:00+05:30`).getTime() + n * 86400000);
const isWeekday = (d) => {
  const wd = new Date(`${d}T12:00:00+05:30`).getUTCDay();
  return wd >= 1 && wd <= 5;
};

// Pichhle `days` calendar din bharo (weekend skip, pehle se bhare din skip)
async function backfill({ days = 30, universe = 'index', strat = 'orb' } = {}) {
  const maxDays = universe === 'index' ? 90 : 10;
  const n = Math.min(Math.max(1, Number(days) || 30), maxDays);
  const today = upstox.istDate(new Date());
  const { minutes } = istParts(new Date());
  const existing = new Set((await PaperTrade.find({ universe, strat }, { day: 1 })).map((x) => x.day));
  let added = 0;
  for (let i = n; i >= 0; i--) {
    const d = addDays(today, -i);
    if (!isWeekday(d) || existing.has(d)) continue;
    if (d === today && minutes < 15 * 60 + 20) continue;
    const rec = await recordDay(d, { universe, strat });
    if (rec) added += 1;
  }
  return { added, days: n, universe, strat };
}

async function summary({ universe = 'index', strat = 'orb' } = {}) {
  const list = await PaperTrade.find({ universe, strat }).sort({ day: 1 });
  const trades = list.filter((x) => !x.noTrade);
  const wins = trades.filter((x) => x.netPnl > 0);
  const losses = trades.filter((x) => x.netPnl <= 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  const curve = [];
  for (const t of list) {
    eq += t.netPnl || 0;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    curve.push({ day: t.day, equity: round2(eq) });
  }
  const months = new Map();
  for (const t of list) {
    const m = t.day.slice(0, 7);
    const x = months.get(m) || { month: m, trades: 0, net: 0 };
    if (!t.noTrade) x.trades += 1;
    x.net = round2(x.net + (t.netPnl || 0));
    months.set(m, x);
  }
  return {
    universe,
    strat,
    days: list.length,
    trades: trades.length,
    noTradeDays: list.length - trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round2((100 * wins.length) / trades.length) : 0,
    net: round2(eq),
    charges: round2(trades.reduce((s, t) => s + (t.charges || 0), 0)),
    avgPerDay: list.length ? round2(eq / list.length) : 0,
    maxDrawdown: round2(dd),
    monthly: [...months.values()],
    curve,
    rows: list.slice().reverse(),
  };
}

async function clear({ universe, strat } = {}) {
  const q = {};
  if (universe) q.universe = universe;
  if (strat) q.strat = strat;
  const r = await PaperTrade.deleteMany(q);
  return r.deletedCount;
}

// Roz 15:35 IST (Mon-Fri) aaj ka record apne aap
function startPaperScheduler({ universe = 'index', strat = 'orb' } = {}) {
  let lastDay = null;
  const timer = setInterval(async () => {
    const { day, minutes } = istParts(new Date());
    if (!isWeekday(day) || minutes < 15 * 60 + 35 || lastDay === day) return;
    if (!(await upstox.getToken())) return;
    lastDay = day;
    try {
      const rec = await recordDay(day, { universe, strat });
      if (rec) console.log(`Paper trade ${day}: ${rec.noTrade ? 'no trade' : `${rec.signal} ${rec.symbol} -> ${rec.result?.text} net ${rec.netPnl}`}`);
    } catch (err) {
      console.error('Paper trade record failed:', err.message);
      lastDay = null;
    }
  }, 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { recordDay, backfill, summary, clear, startPaperScheduler };
