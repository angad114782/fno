// Pure trade logic (no DB) - levels validation, exits, P&L, SL/TP auto-hit.
// Functions mutate the passed trade object (plain object or mongoose doc).

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dir = (side) => (side === 'SELL' ? -1 : 1);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isActive = (trade) => trade.status === 'OPEN' || trade.status === 'PARTIAL';

function formatExpiry(expiry) {
  const d = new Date(expiry);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}${MONTHS[d.getUTCMonth()]}${yy}`;
}

// e.g. "NIFTY 27OCT26 25000 CE" / "BANKNIFTY 27OCT26 FUT"
function buildTradingSymbol({ underlying, segment, expiry, strike, optionType }) {
  const base = `${String(underlying).toUpperCase()} ${formatExpiry(expiry)}`;
  return segment === 'OPT' ? `${base} ${strike} ${optionType}` : `${base} FUT`;
}

function validateContract(t) {
  const errors = [];
  if (!t.underlying) errors.push('underlying is required');
  if (!['FUT', 'OPT'].includes(t.segment)) errors.push('segment must be FUT or OPT');
  if (!['BUY', 'SELL'].includes(t.side)) errors.push('side must be BUY or SELL');
  if (!t.expiry || Number.isNaN(new Date(t.expiry).getTime())) errors.push('valid expiry date is required');
  if (t.segment === 'OPT') {
    if (!['CE', 'PE'].includes(t.optionType)) errors.push('optionType must be CE or PE for options');
    if (!isNum(t.strike) || t.strike <= 0) errors.push('strike is required for options');
  }
  if (!Number.isInteger(t.lots) || t.lots < 1) errors.push('lots must be a positive integer');
  if (!Number.isInteger(t.lotSize) || t.lotSize < 1) errors.push('lotSize must be a positive integer');
  return errors;
}

// BUY:  SL < Entry < TP1 < TP2      SELL: SL > Entry > TP1 > TP2
function validateLevels({ side, entryPrice, stopLoss, target1, target2 }) {
  const errors = [];
  const d = dir(side);
  const below = side === 'SELL' ? 'above' : 'below';
  const above = side === 'SELL' ? 'below' : 'above';

  if (!isNum(entryPrice) || entryPrice <= 0) errors.push('entryPrice must be a positive number');
  for (const [k, v] of Object.entries({ stopLoss, target1, target2 })) {
    if (v != null && (!isNum(v) || v < 0)) errors.push(`${k} must be a non-negative number`);
  }
  if (errors.length) return errors;

  if (stopLoss != null && (entryPrice - stopLoss) * d <= 0) {
    errors.push(`${side}: stopLoss must be ${below} entryPrice`);
  }
  if (target1 != null && (target1 - entryPrice) * d <= 0) {
    errors.push(`${side}: target1 must be ${above} entryPrice`);
  }
  if (target2 != null) {
    if (target1 == null) errors.push('target2 requires target1');
    else if ((target2 - target1) * d <= 0) errors.push(`${side}: target2 must be ${above} target1`);
  }
  return errors;
}

// Validation for modifying levels of a running trade (SL may be trailed into profit).
function validateModify(trade, { stopLoss, target1, target2 }) {
  const errors = [];
  const d = dir(trade.side);
  const sl = stopLoss !== undefined ? stopLoss : trade.stopLoss;
  const t1 = target1 !== undefined ? target1 : trade.target1;
  const t2 = target2 !== undefined ? target2 : trade.target2;

  for (const [k, v] of Object.entries({ stopLoss: sl, target1: t1, target2: t2 })) {
    if (v != null && (!isNum(v) || v < 0)) errors.push(`${k} must be a non-negative number`);
  }
  if (errors.length) return errors;

  if (!trade.tp1Hit && t1 != null && (t1 - trade.entryPrice) * d <= 0) {
    errors.push(`${trade.side}: target1 must be beyond entryPrice`);
  }
  if (t1 != null && t2 != null && (t2 - t1) * d <= 0) errors.push(`${trade.side}: target2 must be beyond target1`);
  if (t2 != null && t1 == null) errors.push('target2 requires target1');
  const nextTarget = !trade.tp1Hit ? t1 : t2;
  if (sl != null && nextTarget != null && (nextTarget - sl) * d <= 0) {
    errors.push(`${trade.side}: stopLoss must be on the loss side of the next target`);
  }
  if (sl != null && isNum(trade.lastPrice) && isActive(trade) && (trade.lastPrice - sl) * d <= 0) {
    errors.push(`${trade.side}: stopLoss would already be hit at last price ${trade.lastPrice}`);
  }
  return errors;
}

function riskReward({ entryPrice, stopLoss, target1, target2 }) {
  if (!isNum(stopLoss)) return { riskPerUnit: null, rrTp1: null, rrTp2: null };
  const risk = Math.abs(entryPrice - stopLoss);
  if (risk === 0) return { riskPerUnit: 0, rrTp1: null, rrTp2: null };
  return {
    riskPerUnit: round2(risk),
    rrTp1: isNum(target1) ? round2(Math.abs(target1 - entryPrice) / risk) : null,
    rrTp2: isNum(target2) ? round2(Math.abs(target2 - entryPrice) / risk) : null,
  };
}

const pnlFor = (side, entry, exit, qty) => round2((exit - entry) * qty * dir(side));

// Initialise derived fields on a new trade.
function initTrade(trade) {
  trade.underlying = String(trade.underlying).toUpperCase();
  trade.quantity = trade.lots * trade.lotSize;
  trade.openQuantity = trade.quantity;
  trade.initialStopLoss = trade.stopLoss ?? null;
  trade.status = 'OPEN';
  trade.tradingSymbol = buildTradingSymbol(trade);
  if (trade.segment === 'FUT') {
    trade.optionType = null;
    trade.strike = null;
  }
  Object.assign(trade, riskReward(trade));
  if (!trade.exits) trade.exits = [];
  return trade;
}

function recompute(trade, { brokeragePerOrder = 0 } = {}) {
  const exits = trade.exits || [];
  const exitedQty = exits.reduce((s, e) => s + e.quantity, 0);
  const gross = exits.reduce((s, e) => s + (e.pnl || 0), 0);

  trade.grossPnl = round2(gross);
  trade.avgExitPrice = exitedQty ? round2(exits.reduce((s, e) => s + e.price * e.quantity, 0) / exitedQty) : null;
  const orders = trade.status === 'CANCELLED' && exits.length === 0 ? 0 : 1 + exits.length;
  trade.charges = round2(brokeragePerOrder * orders + (trade.extraCharges || 0));
  trade.netPnl = round2(trade.grossPnl - trade.charges);

  const initialRisk = isNum(trade.initialStopLoss) ? Math.abs(trade.entryPrice - trade.initialStopLoss) : 0;
  trade.rMultiple = initialRisk > 0 ? round2(trade.grossPnl / (initialRisk * trade.quantity)) : null;

  if (trade.status === 'CLOSED') {
    trade.result = trade.netPnl > 0 ? 'WIN' : trade.netPnl < 0 ? 'LOSS' : 'BREAKEVEN';
  } else {
    trade.result = null;
  }
  return trade;
}

function applyExit(trade, { price, quantity, reason = 'MANUAL', time = new Date() }, opts = {}) {
  if (!isActive(trade)) throw new Error(`Trade is ${trade.status}, cannot exit`);
  if (!isNum(price) || price < 0) throw new Error('exit price must be a non-negative number');
  const qty = quantity == null ? trade.openQuantity : quantity;
  if (!Number.isInteger(qty) || qty < 1) throw new Error('exit quantity must be a positive integer');
  if (qty > trade.openQuantity) throw new Error(`exit quantity ${qty} > open quantity ${trade.openQuantity}`);
  if (qty % trade.lotSize !== 0) throw new Error(`exit quantity must be a multiple of lot size ${trade.lotSize}`);

  const pnl = pnlFor(trade.side, trade.entryPrice, price, qty);
  trade.exits.push({ price: round2(price), quantity: qty, reason, time, pnl });
  trade.openQuantity -= qty;
  if (trade.openQuantity === 0) {
    trade.status = 'CLOSED';
    trade.exitTime = time;
  } else {
    trade.status = 'PARTIAL';
  }
  recompute(trade, opts);
  return { type: 'EXIT', reason, price: round2(price), quantity: qty, pnl };
}

/**
 * LTP update -> auto check SL / TP1 / TP2.
 * - SL checked first (conservative). SL fill = LTP (gap ho to actual worse price).
 * - TP fills = target price (limit order assumption).
 * - TP1: books tp1ExitPercent of open qty (lot-rounded). If no TP2, books everything.
 *   Agar 1 hi lot hai to sirf TP1 mark hota hai aur SL cost pe shift hota hai.
 */
function onPriceUpdate(trade, ltp, opts = {}) {
  const { tp1ExitPercent = 50, moveSlToCostOnTp1 = true, time = new Date() } = opts;
  if (!isNum(ltp) || ltp < 0) throw new Error('ltp must be a non-negative number');
  if (!isActive(trade)) return [];

  const d = dir(trade.side);
  const events = [];
  trade.lastPrice = ltp;
  trade.lastPriceAt = time;

  if (isNum(trade.stopLoss) && (ltp - trade.stopLoss) * d <= 0) {
    const trailed = trade.stopLoss !== trade.initialStopLoss;
    const reason = trailed ? 'TRAIL_SL' : 'SL';
    const exit = applyExit(trade, { price: ltp, reason, time }, opts);
    trade.slHit = true;
    trade.slHitAt = time;
    events.push({ type: trailed ? 'TRAIL_SL_HIT' : 'SL_HIT', level: trade.stopLoss, ltp, exit });
    return events;
  }

  if (!trade.tp1Hit && isNum(trade.target1) && (ltp - trade.target1) * d >= 0) {
    trade.tp1Hit = true;
    trade.tp1HitAt = time;
    let qty;
    if (!isNum(trade.target2)) {
      qty = trade.openQuantity;
    } else {
      const raw = (trade.openQuantity * tp1ExitPercent) / 100;
      qty = Math.floor(raw / trade.lotSize) * trade.lotSize;
    }
    const exit = qty > 0 ? applyExit(trade, { price: trade.target1, quantity: qty, reason: 'TP1', time }, opts) : null;
    let slMovedTo = null;
    if (moveSlToCostOnTp1 && trade.openQuantity > 0) {
      trade.stopLoss = trade.entryPrice;
      slMovedTo = trade.entryPrice;
    }
    events.push({ type: 'TP1_HIT', level: trade.target1, ltp, exit, slMovedTo });
  }

  if (trade.openQuantity > 0 && !trade.tp2Hit && isNum(trade.target2) && (ltp - trade.target2) * d >= 0) {
    trade.tp2Hit = true;
    trade.tp2HitAt = time;
    const exit = applyExit(trade, { price: trade.target2, reason: 'TP2', time }, opts);
    events.push({ type: 'TP2_HIT', level: trade.target2, ltp, exit });
  }

  return events;
}

function cancelTrade(trade, opts = {}) {
  if (trade.status !== 'OPEN' || (trade.exits && trade.exits.length)) {
    throw new Error('Only OPEN trades without exits can be cancelled');
  }
  trade.status = 'CANCELLED';
  trade.openQuantity = 0;
  recompute(trade, opts);
  return trade;
}

module.exports = {
  round2,
  formatExpiry,
  buildTradingSymbol,
  validateContract,
  validateLevels,
  validateModify,
  riskReward,
  pnlFor,
  initTrade,
  recompute,
  applyExit,
  onPriceUpdate,
  cancelTrade,
  isActive,
};
