const Trade = require('../models/Trade');
const Instrument = require('../models/Instrument');
const config = require('../config/env');
const engine = require('./tradeEngine');
const notifier = require('./notifier');
const HttpError = require('../utils/httpError');

const rules = () => config.rules;

const toNum = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const toNullableNum = (v) => (v === null || v === '' ? null : toNum(v));

function notifyEvents(trade, events) {
  for (const ev of events) notifier.sendTelegram(notifier.eventMsg(trade, ev));
}

async function findTrade(id) {
  const trade = await Trade.findById(id);
  if (!trade) throw new HttpError(404, 'Trade not found');
  return trade;
}

async function createTrade(input, { source = 'MANUAL' } = {}) {
  const underlying = String(input.underlying || '').toUpperCase().trim();
  const instrument = underlying ? await Instrument.findOne({ symbol: underlying }) : null;

  const data = {
    underlying,
    instrumentType: input.instrumentType || instrument?.type || 'STOCK',
    exchange: input.exchange || instrument?.exchange || 'NSE',
    segment: String(input.segment || '').toUpperCase(),
    optionType: input.optionType ? String(input.optionType).toUpperCase() : null,
    strike: toNum(input.strike) ?? null,
    expiry: input.expiry,
    side: String(input.side || '').toUpperCase(),
    lotSize: toNum(input.lotSize) ?? instrument?.lotSize,
    lots: toNum(input.lots) ?? (input.quantity && instrument ? Number(input.quantity) / instrument.lotSize : 1),
    entryPrice: toNum(input.entryPrice),
    entryTime: input.entryTime ? new Date(input.entryTime) : new Date(),
    stopLoss: toNum(input.stopLoss) ?? null,
    target1: toNum(input.target1) ?? null,
    target2: toNum(input.target2) ?? null,
    extraCharges: toNum(input.extraCharges) ?? 0,
    strategy: input.strategy,
    tags: Array.isArray(input.tags) ? input.tags : input.tags ? String(input.tags).split(',').map((s) => s.trim()) : [],
    notes: input.notes,
    source,
  };

  if (data.lotSize == null) {
    throw new HttpError(400, `Unknown underlying "${underlying}". Pass lotSize or add it via /api/instruments`);
  }

  const errors = [...engine.validateContract(data), ...engine.validateLevels(data)];
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);

  engine.initTrade(data);
  engine.recompute(data, rules());
  const trade = await Trade.create(data);
  notifier.sendTelegram(notifier.tradeCreatedMsg(trade));
  return trade;
}

async function updateTrade(id, input) {
  const trade = await findTrade(id);
  const levels = {};
  for (const k of ['stopLoss', 'target1', 'target2']) {
    if (k in input) levels[k] = toNullableNum(input[k]);
  }

  if (Object.keys(levels).length) {
    if (!engine.isActive(trade)) throw new HttpError(400, `Cannot modify levels of a ${trade.status} trade`);
    const errors = engine.validateModify(trade, levels);
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);
    Object.assign(trade, levels);
    // Before any exit, SL change = new initial risk
    if ('stopLoss' in levels && trade.exits.length === 0 && !trade.tp1Hit) trade.initialStopLoss = levels.stopLoss;
    Object.assign(trade, engine.riskReward({ ...trade.toObject(), stopLoss: trade.initialStopLoss }));
  }

  for (const k of ['strategy', 'notes']) if (k in input) trade[k] = input[k];
  if ('tags' in input) trade.tags = Array.isArray(input.tags) ? input.tags : String(input.tags).split(',').map((s) => s.trim());
  if ('extraCharges' in input) trade.extraCharges = toNum(input.extraCharges) ?? 0;

  engine.recompute(trade, rules());
  await trade.save();
  return trade;
}

async function exitTrade(id, { price, quantity, reason = 'MANUAL', time }) {
  const trade = await findTrade(id);
  try {
    const ev = engine.applyExit(
      trade,
      { price: toNum(price), quantity: toNum(quantity), reason, time: time ? new Date(time) : new Date() },
      rules()
    );
    await trade.save();
    notifyEvents(trade, [ev]);
    return { trade, events: [ev] };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err.message);
  }
}

async function cancelTrade(id) {
  const trade = await findTrade(id);
  try {
    engine.cancelTrade(trade, rules());
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  await trade.save();
  return trade;
}

async function priceUpdate(trade, ltp) {
  let events;
  try {
    events = engine.onPriceUpdate(trade, toNum(ltp), rules());
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  await trade.save();
  notifyEvents(trade, events);
  return { trade, events };
}

async function priceUpdateById(id, ltp) {
  return priceUpdate(await findTrade(id), ltp);
}

// Bulk: [{ symbol: "NIFTY 27OCT26 25000 CE", ltp: 123.4 }, ...]
async function priceUpdateBySymbol(updates) {
  const results = [];
  for (const u of updates) {
    const symbol = String(u.symbol || u.tradingSymbol || '').toUpperCase().trim().replace(/\s+/g, ' ');
    if (!symbol) continue;
    const trades = await Trade.find({ tradingSymbol: symbol, status: { $in: ['OPEN', 'PARTIAL'] } });
    for (const t of trades) {
      const { events } = await priceUpdate(t, u.ltp);
      results.push({ tradeId: t._id, symbol, status: t.status, events });
    }
  }
  return results;
}

function buildFilter(q = {}) {
  const filter = {};
  if (q.status) filter.status = { $in: String(q.status).toUpperCase().split(',') };
  if (q.underlying) filter.underlying = { $in: String(q.underlying).toUpperCase().split(',') };
  if (q.segment) filter.segment = String(q.segment).toUpperCase();
  if (q.side) filter.side = String(q.side).toUpperCase();
  if (q.optionType) filter.optionType = String(q.optionType).toUpperCase();
  if (q.strategy) filter.strategy = q.strategy;
  if (q.tag) filter.tags = q.tag;
  if (q.from || q.to) {
    filter.entryTime = {};
    if (q.from) filter.entryTime.$gte = new Date(q.from);
    if (q.to) {
      const to = new Date(q.to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) to.setUTCHours(23, 59, 59, 999);
      filter.entryTime.$lte = to;
    }
  }
  return filter;
}

async function listTrades(q = {}) {
  const limit = Math.min(Number(q.limit) || 100, 1000);
  const page = Math.max(Number(q.page) || 1, 1);
  const filter = buildFilter(q);
  const [items, total] = await Promise.all([
    Trade.find(filter).sort({ entryTime: -1 }).skip((page - 1) * limit).limit(limit),
    Trade.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

async function deleteTrade(id) {
  const trade = await Trade.findByIdAndDelete(id);
  if (!trade) throw new HttpError(404, 'Trade not found');
  return trade;
}

module.exports = {
  findTrade,
  createTrade,
  updateTrade,
  exitTrade,
  cancelTrade,
  priceUpdateById,
  priceUpdateBySymbol,
  buildFilter,
  listTrades,
  deleteTrade,
};
