// Upstox historical candles fetch karke backtest chalata hai aur result DB me save karta hai.
const config = require('../config/env');
const upstox = require('./upstox');
const instruments = require('./instruments');
const backtest = require('./backtest');
const autoDefaults = require('./autoDefaults');
const riskService = require('./riskService');
const Instrument = require('../models/Instrument');
const BacktestRun = require('../models/BacktestRun');
const HttpError = require('../utils/httpError');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function runBacktest(input = {}) {
  const symbol = String(input.symbol || '').toUpperCase().trim();
  if (!symbol) throw new HttpError(400, 'symbol required');
  const interval = Number(input.interval) || 5;
  if (![1, 3, 5, 10, 15, 30, 60].includes(interval)) throw new HttpError(400, 'interval 1/3/5/10/15/30/60 me se ho');
  const to = isDate(input.to) ? input.to : upstox.istDate(new Date());
  const from = isDate(input.from) ? input.from : upstox.istDate(Date.now() - 90 * 86400000);
  if (from > to) throw new HttpError(400, 'from date to se pehle honi chahiye');
  if (from < '2022-01-01') throw new HttpError(400, 'Upstox minute data Jan 2022 se hi available hai');
  const days = (new Date(to) - new Date(from)) / 86400000;
  if (days > 400) throw new HttpError(400, 'Max ~1 saal ka range ek baar me');

  const info = await instruments.resolve(symbol);
  if (!info) throw new HttpError(404, `"${symbol}" Upstox instruments me nahi mila`);
  const dbInst = await Instrument.findOne({ symbol });
  const lotSize = Number(input.lotSize) || info.lotSize || dbInst?.lotSize || 1;

  // Indicators (EMA/ATR/Supertrend) ke warm-up ke liye 7 din pehle se data; trades sirf `from` se
  const warmFrom = upstox.istDate(new Date(`${from}T00:00:00Z`).getTime() - 7 * 86400000);
  const candles = await upstox.getCandles(info.underlyingKey, { unit: 'minutes', interval, from: warmFrom, to });
  if (!candles.some((c) => upstox.istDate(c.time) >= from)) {
    throw new HttpError(422, `${from}${from !== to ? ` se ${to}` : ''} me market data nahi mila (holiday/weekend?)`);
  }

  // Delta, slippage, charges: user ne na diye ho to Upstox se apne aap
  const lots = Math.max(1, parseInt(input.lots, 10) || 1);
  const auto = await autoDefaults.forSymbol(symbol, lots);
  const given = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

  // Capital rules (live jaisa): risk/trade, din aur mahine ka loss limit. input.capitalRules=false se off
  const useRules = !(input.capitalRules === false || String(input.capitalRules) === 'false');
  let capital = null;
  if (useRules) {
    const rules = await riskService.effectiveRules();
    if (given(input.capital)) rules.capital = Number(input.capital);
    capital = { ...rules, ...riskService.derived(rules) };
  }

  const mode = String(input.mode || 'OPTION').toUpperCase() === 'FUTURES' ? 'FUTURES' : 'OPTION';
  const params = { ...(input.params || {}) };
  if (capital && (params.maxTradesPerDay === undefined || params.maxTradesPerDay === '')) params.maxTradesPerDay = capital.maxTradesPerDay;
  const result = backtest.run(candles, params, {
    mode,
    delta: given(input.delta) ? Number(input.delta) : auto.delta,
    lots,
    lotSize,
    strikeStep: dbInst?.strikeStep || 50,
    brokeragePerOrder: auto.charges.perOrderFixed,
    variableChargesPerTrade: auto.charges.variableRoundTrip,
    slippagePts: given(input.slippagePts) ? Number(input.slippagePts) : auto.slippagePts,
    tp1ExitPercent: config.rules.tp1ExitPercent,
    moveSlToCostOnTp1: config.rules.moveSlToCostOnTp1,
    underlying: symbol,
    tradeFrom: from,
    riskPerTrade: capital?.riskPerTrade,
    dailyLossLimit: capital?.dailyLossLimit,
    monthlyLossLimit: capital?.monthlyLossLimit,
  });

  const run = await BacktestRun.create({
    ...result,
    auto,
    capital,
    symbol,
    interval,
    from,
    to,
    mode,
  });
  return run;
}

const listRuns = () =>
  BacktestRun.find({}, { trades: 0, daily: 0, equityCurve: 0, sessions: 0 }).sort({ createdAt: -1 }).limit(50);

async function getRun(id) {
  const run = await BacktestRun.findById(id);
  if (!run) throw new HttpError(404, 'Backtest not found');
  return run;
}

async function deleteRun(id) {
  const run = await BacktestRun.findByIdAndDelete(id);
  if (!run) throw new HttpError(404, 'Backtest not found');
  return run;
}

async function clearRuns() {
  const r = await BacktestRun.deleteMany({});
  return r.deletedCount;
}

module.exports = { runBacktest, listRuns, getRun, deleteRun, clearRuns };
