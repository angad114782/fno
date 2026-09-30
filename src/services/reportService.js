const Trade = require('../models/Trade');
const config = require('../config/env');
const reports = require('./reportEngine');
const { buildFilter } = require('./tradeService');
const notifier = require('./notifier');
const { toCsv } = require('../utils/csv');

// Closed trades are bucketed by exit time, open ones by entry time.
function reportFilter(q = {}) {
  const { from, to, ...rest } = q;
  const filter = buildFilter(rest);
  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) end.setUTCHours(23, 59, 59, 999);
      range.$lte = end;
    }
    filter.$or = [{ exitTime: range }, { exitTime: null, entryTime: range }];
  }
  return filter;
}

async function fetchTrades(q) {
  return Trade.find(reportFilter(q)).sort({ entryTime: 1 }).lean();
}

async function fullReport(q = {}) {
  const trades = await fetchTrades(q);
  const tz = config.timezone;
  return {
    filters: q,
    summary: reports.summarize(trades),
    daily: reports.daily(trades, tz),
    monthly: reports.monthly(trades, tz),
    byUnderlying: reports.byUnderlying(trades),
    byStrategy: reports.byStrategy(trades),
    bySide: reports.bySide(trades),
  };
}

// IST day boundaries -> UTC Date range
function dayRange(dateStr, timeZone = config.timezone) {
  const key = dateStr || reports.dateKey(new Date(), timeZone);
  // offset of timezone at that day (works for fixed offsets like IST)
  const probe = new Date(`${key}T12:00:00Z`);
  const local = new Date(probe.toLocaleString('en-US', { timeZone }));
  const offsetMs = local.getTime() - probe.getTime();
  const start = new Date(new Date(`${key}T00:00:00Z`).getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1);
  return { key, start, end };
}

async function dayReport(dateStr) {
  const { key, start, end } = dayRange(dateStr);
  const trades = await Trade.find({
    $or: [{ exitTime: { $gte: start, $lte: end } }, { status: { $in: ['OPEN', 'PARTIAL'] } }],
  }).lean();
  return { date: key, summary: reports.summarize(trades), trades };
}

async function sendDayReport(dateStr) {
  const { date, summary } = await dayReport(dateStr);
  return notifier.send(notifier.summaryMsg(`Day Report ${date}`, summary));
}

const CSV_COLUMNS = [
  { label: 'Entry Time', value: 'entryTime' },
  { label: 'Exit Time', value: 'exitTime' },
  { label: 'Symbol', value: 'tradingSymbol' },
  { label: 'Underlying', value: 'underlying' },
  { label: 'Type', value: 'instrumentType' },
  { label: 'Segment', value: 'segment' },
  { label: 'Option', value: 'optionType' },
  { label: 'Strike', value: 'strike' },
  { label: 'Expiry', value: (t) => (t.expiry ? new Date(t.expiry).toISOString().slice(0, 10) : '') },
  { label: 'Side', value: 'side' },
  { label: 'Lots', value: 'lots' },
  { label: 'Lot Size', value: 'lotSize' },
  { label: 'Qty', value: 'quantity' },
  { label: 'Entry', value: 'entryPrice' },
  { label: 'SL', value: 'initialStopLoss' },
  { label: 'Final SL', value: 'stopLoss' },
  { label: 'TP1', value: 'target1' },
  { label: 'TP2', value: 'target2' },
  { label: 'TP1 Hit', value: (t) => (t.tp1Hit ? 'YES' : 'NO') },
  { label: 'TP2 Hit', value: (t) => (t.tp2Hit ? 'YES' : 'NO') },
  { label: 'SL Hit', value: (t) => (t.slHit ? 'YES' : 'NO') },
  { label: 'Avg Exit', value: 'avgExitPrice' },
  { label: 'Exits', value: (t) => (t.exits || []).map((e) => `${e.reason}:${e.quantity}@${e.price}`).join(' | ') },
  { label: 'Status', value: 'status' },
  { label: 'Result', value: 'result' },
  { label: 'Gross P&L', value: 'grossPnl' },
  { label: 'Charges', value: 'charges' },
  { label: 'Net P&L', value: 'netPnl' },
  { label: 'R Multiple', value: 'rMultiple' },
  { label: 'Strategy', value: 'strategy' },
  { label: 'Tags', value: (t) => (t.tags || []).join(';') },
  { label: 'Notes', value: 'notes' },
];

async function exportCsv(q) {
  return toCsv(await fetchTrades(q), CSV_COLUMNS);
}

module.exports = { reportFilter, fullReport, dayRange, dayReport, sendDayReport, exportCsv };
