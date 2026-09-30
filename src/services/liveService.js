// Market hours me background loops:
// 1) Open trades ka LTP Upstox se -> auto SL / TP1 / TP2 check
// 2) Watchlist scan har candle close pe -> naya signal aaye to WhatsApp alert
// 3) Alert kiye signal ka option LTP track -> T1 / T2 / SL / time stop pe EXIT alert (scalping)
const config = require('../config/env');
const Trade = require('../models/Trade');
const upstox = require('./upstox');
const instruments = require('./instruments');
const tradeService = require('./tradeService');
const analysis = require('./analysisService');
const notifier = require('./notifier');
const riskService = require('./riskService');

const state = { lastPoll: null, lastError: null, lastScan: null, lastSignals: [], risk: null };
const alerted = new Set();
// Alert kiye signals jinka option abhi track ho raha hai: key -> { symbol, option, sl, t1, t2, t1Hit, deadline }
const watched = new Map();
const strategy = require('./strategy');

const scanParams = () => ({ strategy: config.signals.strategy });

async function pollOpenTrades() {
  const trades = await Trade.find({ status: { $in: ['OPEN', 'PARTIAL'] } });
  if (!trades.length) return 0;
  for (const t of trades) {
    if (!t.instrumentKey) {
      t.instrumentKey = await instruments.contractKey(t);
      if (t.instrumentKey) await t.save();
    }
  }
  const withKey = trades.filter((t) => t.instrumentKey);
  if (!withKey.length) return 0;
  const ltp = await upstox.getLtp(withKey.map((t) => t.instrumentKey));
  let n = 0;
  for (const t of withKey) {
    const px = ltp[t.instrumentKey];
    if (px == null) continue;
    await tradeService.priceUpdate(t, px);
    n += 1;
  }
  return n;
}

const timeStopMin = () => {
  const p = strategy.withDefaults(scanParams());
  return p.timeStopBars > 0 ? p.timeStopBars * config.signals.intervalMin : null;
};

// Line 1-4 WhatsApp template ke pehle 4 params me jaati hain, baaki aakhri me
function signalMsg(r) {
  const o = r.option;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ts = timeStopMin();
  const ok = o && !o.error;
  return [
    `📡 <b>${esc(r.action)}</b> ${esc(r.symbol)} @ ${r.spot}`,
    ok ? `${esc(o.underlying)} ${o.strike} ${o.optionType} (${o.expiry})` : 'Option plan nahi bana',
    ok ? `Entry ~${o.entryPrice} | SL ${o.stopLoss} | T1 ${o.target1}${o.target2 != null ? ` | T2 ${o.target2}` : ''}` : '-',
    ok ? `Lots ${o.lots} (max loss ~₹${o.maxLoss})${ts ? ` · ${ts} min me T1 nahi to EXIT` : ''}` : '-',
    `Score ${r.score} · RSI ${r.rsi}${r.pcr != null ? ` · PCR ${r.pcr}` : ''}`,
    '<i>Rule-based signal, guarantee nahi. SL zaroor lagao.</i>',
  ].join('\n');
}

function watchSignal(key, r) {
  const o = r.option;
  if (!o || o.error || !o.instrumentKey) return;
  const ts = timeStopMin();
  watched.set(key, {
    symbol: r.symbol,
    name: `${o.underlying} ${o.strike} ${o.optionType}`,
    instrumentKey: o.instrumentKey,
    entry: o.entryPrice,
    sl: o.stopLoss,
    t1: o.target1,
    t2: o.target2,
    t1Hit: false,
    at: Date.now(),
    deadline: ts ? Date.now() + ts * 60000 : null,
  });
}

function exitMsg(w, title, px, action) {
  const pts = Math.round((px - w.entry) * 100) / 100;
  return [`${title} ${w.name}`, `LTP ${px} (entry ${w.entry}, ${pts >= 0 ? '+' : ''}${pts} pts)`, action, `${Math.round((Date.now() - w.at) / 60000)} min trade me`, '-'].join('\n');
}

// Signal ke option ka LTP -> exit alerts. Ek signal pe max: T1 alert + ek final exit alert
async function pollWatched() {
  if (!watched.size) return 0;
  const ltp = await upstox.getLtp([...watched.values()].map((w) => w.instrumentKey));
  for (const [key, w] of watched) {
    const px = ltp[w.instrumentKey];
    if (px == null) continue;
    let done = null;
    if (px <= w.sl) done = exitMsg(w, w.t1Hit ? '🛡️ COST SL HIT' : '🛑 SL HIT', px, w.t1Hit ? 'Baaki qty cost pe bahar' : 'Turant bahar niklo, average mat karo');
    else if (w.t2 != null && px >= w.t2) done = exitMsg(w, '🎯🎯 T2 HIT', px, 'Poori qty book karo');
    else if (!w.t1Hit && px >= w.t1) {
      w.t1Hit = true;
      w.sl = w.entry; // SL cost pe
      if (w.t2 == null) done = exitMsg(w, '🎯 T1 HIT', px, 'Poori qty book karo');
      else if (config.signals.alerts) notifier.send(exitMsg(w, '🎯 T1 HIT', px, `Aadhi qty book karo, SL cost (${w.entry}) pe`));
    } else if (!w.t1Hit && w.deadline && Date.now() >= w.deadline) {
      done = exitMsg(w, '⏱️ TIME EXIT', px, 'Momentum nahi aaya - abhi bahar niklo (theta se bachav)');
    }
    if (done) {
      if (config.signals.alerts) notifier.send(done);
      console.log(done.split('\n')[0]);
      watched.delete(key);
    }
  }
  return watched.size;
}

async function scanWatchlist() {
  const list = await analysis.scan(config.signals.watchlist, { interval: config.signals.intervalMin, params: scanParams() });
  state.lastScan = new Date();
  state.lastSignals = list;
  for (const r of list) {
    if (r.error || r.action === 'WAIT' || r.action === 'STOP') continue;
    const key = `${r.symbol}|${r.time}|${r.direction}`;
    if (alerted.has(key)) continue;
    alerted.add(key);
    if (config.signals.alerts) notifier.send(signalMsg(r));
    watchSignal(key, r);
    console.log(`SIGNAL ${r.action} ${r.symbol} @ ${r.spot} (score ${r.score})`);
  }
  if (alerted.size > 2000) alerted.clear();
  return list;
}

// Capital protection monitor: limit cross hote hi ek baar WhatsApp alert
let lastRiskState = 'OK';
async function checkRisk() {
  const st = await riskService.status();
  state.risk = { state: st.state, today: st.today, month: st.month, at: new Date() };
  if (st.state !== 'OK' && st.state !== lastRiskState) {
    notifier.send(['🛑 <b>TRADING STOP</b>', ...st.reasons, '', 'Rule tod ke trade mat lo. Kal fresh start.'].join('\n'));
    console.log('RISK STOP:', st.reasons.join(' | '));
  }
  lastRiskState = st.state;
  return st;
}

function startLive() {
  const timers = [];
  timers.push(
    setInterval(async () => {
      if (!analysis.marketState().open || !(await upstox.getToken())) return;
      try {
        await checkRisk();
      } catch (err) {
        state.lastError = err.message;
      }
    }, 60 * 1000)
  );
  let busy = false;
  if (config.livePollSeconds > 0) {
    timers.push(
      setInterval(async () => {
        if (busy || !analysis.marketState().open || !(await upstox.getToken())) return;
        busy = true;
        try {
          await pollOpenTrades();
          await pollWatched();
          state.lastPoll = new Date();
          state.lastError = null;
        } catch (err) {
          state.lastError = err.message;
        } finally {
          busy = false;
        }
      }, config.livePollSeconds * 1000)
    );
  }

  let lastSlot = null;
  timers.push(
    setInterval(async () => {
      const mkt = analysis.marketState();
      if (!mkt.open || !config.signals.watchlist.length) return;
      const iv = config.signals.intervalMin;
      const slot = Math.floor(mkt.minutes / iv);
      // candle close ke ~20 sec baad (Upstox pe candle aa jaye)
      if (slot === lastSlot || new Date().getUTCSeconds() < 20) return;
      if (!(await upstox.getToken())) return;
      lastSlot = slot;
      try {
        await scanWatchlist();
      } catch (err) {
        state.lastError = err.message;
      }
    }, 10 * 1000)
  );
  timers.forEach((t) => t.unref());
  console.log(`Live engine: LTP poll ${config.livePollSeconds}s, ${config.signals.strategy} signal scan every ${config.signals.intervalMin}m [${config.signals.watchlist.join(', ')}]`);
  return timers;
}

module.exports = { startLive, pollOpenTrades, pollWatched, scanWatchlist, checkRisk, signalMsg, state, watched };
