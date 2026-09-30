// Capital protection: rules (capital, risk %, daily/monthly loss limit, max trades) + aaj/mahine ka asli P&L.
// Limit cross -> state STOP (Signals tab trade suggest nahi karega, WhatsApp alert).
const config = require('../config/env');
const Setting = require('../models/Setting');
const Trade = require('../models/Trade');
const upstox = require('./upstox');
const { estimateCharges } = require('./brokerStats');
const autoDefaults = require('./autoDefaults');
const { istParts } = require('./indicators');
const { round2 } = require('./tradeEngine');
const HttpError = require('../utils/httpError');

const RULES_KEY = 'risk_rules';
const FO_EXCHANGES = new Set(['NFO', 'BFO', 'NSE_FO', 'BSE_FO']);

const DEFAULT_RULES = () => ({
  capitalSource: 'upstox', // upstox = trading balance apne aap, manual = neeche wala capital
  capital: config.risk.capital,
  riskPct: config.risk.riskPct, // ek trade me capital ka max % loss
  maxTradesPerDay: config.risk.maxTradesPerDay,
  dailyLossPct: config.risk.dailyLossPct,
  monthlyLossPct: config.risk.monthlyLossPct,
  noExpiryDay: config.risk.noExpiryDay, // expiry day pe us din expire hone wale option nahi (next expiry)
});

async function getRules() {
  const s = await Setting.findOne({ key: RULES_KEY });
  return { ...DEFAULT_RULES(), ...(s?.value || {}) };
}

function derived(rules) {
  const pct = (p) => round2((rules.capital * p) / 100);
  return { riskPerTrade: pct(rules.riskPct), dailyLossLimit: pct(rules.dailyLossPct), monthlyLossLimit: pct(rules.monthlyLossPct) };
}

async function saveRules(input = {}) {
  const cur = await getRules();
  const next = { ...cur };
  const nums = { capital: [1000, 1e9], riskPct: [0.1, 10], maxTradesPerDay: [1, 50], dailyLossPct: [0.5, 50], monthlyLossPct: [1, 100] };
  for (const [k, [min, max]] of Object.entries(nums)) {
    if (input[k] === undefined || input[k] === '') continue;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${k} ${min}-${max} ke beech hona chahiye`);
    next[k] = k === 'maxTradesPerDay' ? Math.round(v) : v;
  }
  if (input.capitalSource === 'upstox' || input.capitalSource === 'manual') next.capitalSource = input.capitalSource;
  if (input.noExpiryDay !== undefined) next.noExpiryDay = input.noExpiryDay === true || String(input.noExpiryDay) === 'true';
  await Setting.findOneAndUpdate({ key: RULES_KEY }, { value: next }, { upsert: true });
  monthCache = null;
  return { ...next, ...derived(next) };
}

// ---- Aaj ka P&L + trades: Upstox (positions + trades) ya Journal fallback ----
async function todayFromUpstox() {
  const [positions, fills] = await Promise.all([
    upstox.request('/v2/portfolio/short-term-positions'),
    upstox.request('/v2/order/trades/get-trades-for-day'),
  ]);
  const fo = (positions || []).filter((p) => FO_EXCHANGES.has(p.exchange));
  const pnl = fo.reduce((s, p) => s + (Number(p.pnl) || (Number(p.realised) || 0) + (Number(p.unrealised) || 0)), 0);
  const foFills = (fills || []).filter((t) => FO_EXCHANGES.has(t.exchange));
  const entries = new Set(foFills.filter((t) => t.transaction_type === 'BUY').map((t) => t.order_id)).size;
  const orders = new Set(foFills.map((t) => t.order_id)).size;
  const openPositions = fo.filter((p) => Number(p.quantity) !== 0).length;
  // Approx charges: har order Rs brokerage (+ taxes andaza ~Rs 10/order)
  const estCharges = orders * (config.rules.brokeragePerOrder + 10);
  return { source: 'upstox', grossPnl: round2(pnl), estCharges, pnl: round2(pnl - estCharges), trades: entries, orders, openPositions };
}

async function todayFromJournal() {
  const { day } = istParts(new Date());
  const start = new Date(`${day}T00:00:00+05:30`);
  const trades = await Trade.find({ entryTime: { $gte: start }, status: { $ne: 'CANCELLED' } });
  const pnl = trades.reduce((s, t) => {
    const d = t.side === 'SELL' ? -1 : 1;
    const unreal = t.lastPrice != null ? (t.lastPrice - t.entryPrice) * t.openQuantity * d : 0;
    return s + (t.netPnl || 0) + unreal;
  }, 0);
  return { source: 'journal', pnl: round2(pnl), trades: trades.length, openPositions: trades.filter((t) => ['OPEN', 'PARTIAL'].includes(t.status)).length };
}

// ---- Mahine ka P&L: Upstox P&L report (T+1) + aaj ----
let monthCache = null; // { key, value, at }
const fyCode = (d) => {
  const [y, m] = d.split('-').map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${String(s).slice(-2)}${String(s + 1).slice(-2)}`;
};
const toDmy = (d) => d.split('-').reverse().join('-');

async function monthFromUpstox(today) {
  const monthStart = `${today.slice(0, 8)}01`;
  const key = today;
  if (monthCache && monthCache.key === key && Date.now() - monthCache.at < 15 * 60000) return monthCache.value;
  let rows = [];
  try {
    rows = await upstox.request('/v2/trade/profit-loss/data', {
      query: { segment: 'FO', financial_year: fyCode(today), from_date: toDmy(monthStart), to_date: toDmy(today), page_number: 1, page_size: 5000 },
    });
  } catch (err) {
    if (err.status === 424) throw err;
    rows = []; // report available na ho to 0 maan lo
  }
  const todayDmy = toDmy(today);
  const past = (rows || []).filter((r) => r.buy_date !== todayDmy && r.sell_date !== todayDmy);
  const net = past.reduce((s, r) => s + (r.sell_amount - r.buy_amount) - estimateCharges(r, config.rules.brokeragePerOrder), 0);
  const value = { pnlBeforeToday: round2(net), trades: past.length };
  monthCache = { key, value, at: Date.now() };
  return value;
}

// Rules + asli capital (Upstox balance, agar source upstox aur balance mila)
async function effectiveRules() {
  const rules = await getRules();
  rules.capitalFrom = 'manual';
  if (rules.capitalSource === 'upstox' && (await upstox.getToken())) {
    const bal = await autoDefaults.capital();
    if (bal) {
      rules.capital = bal;
      rules.capitalFrom = 'upstox';
    }
  }
  return rules;
}

async function status() {
  const rules = await effectiveRules();
  const lim = derived(rules);
  const { day } = istParts(new Date());
  const connected = Boolean(await upstox.getToken());
  let today;
  let month = { pnlBeforeToday: 0, trades: 0 };
  const errors = [];
  try {
    today = connected ? await todayFromUpstox() : await todayFromJournal();
  } catch (err) {
    errors.push(`Aaj ka P&L: ${err.message}`);
    today = await todayFromJournal();
  }
  if (connected) {
    try {
      month = await monthFromUpstox(day);
    } catch (err) {
      errors.push(`Mahine ka P&L: ${err.message}`);
    }
  }
  const monthPnl = round2(month.pnlBeforeToday + today.pnl);

  const reasons = [];
  let state = 'OK';
  if (monthPnl <= -lim.monthlyLossLimit) {
    state = 'STOP_MONTH';
    reasons.push(`Is mahine ka loss Rs ${Math.abs(monthPnl)} limit (Rs ${lim.monthlyLossLimit}) se zyada. Mahine ke baaki din sirf paper trading.`);
  }
  if (today.pnl <= -lim.dailyLossLimit) {
    if (state === 'OK') state = 'STOP_DAY';
    reasons.push(`Aaj ka loss Rs ${Math.abs(today.pnl)} daily limit (Rs ${lim.dailyLossLimit}) cross. Aaj ke liye trading band.`);
  }
  if (today.trades >= rules.maxTradesPerDay) {
    if (state === 'OK') state = 'STOP_DAY';
    reasons.push(`Aaj ${today.trades} trade ho chuke (max ${rules.maxTradesPerDay}). Overtrading se bacho - aaj band.`);
  }
  return {
    state,
    reasons,
    rules: { ...rules, ...lim },
    today,
    month: { ...month, pnl: monthPnl },
    day,
    errors,
  };
}

module.exports = { getRules, effectiveRules, saveRules, derived, status, fyCode };
