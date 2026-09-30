// Asli option premium backtest (Iron Fly / ORB option buy) + kitna fund chahiye (Upstox margin API)
const config = require('../config/env');
const upstox = require('./upstox');
const instruments = require('./instruments');
const optionData = require('./optionData');
const ob = require('./optionBacktest');
const HttpError = require('../utils/httpError');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === true || String(v) === 'true');

// Upstox margin API se basket ka margin (hedge benefit ke saath)
async function basketMargin(legs) {
  const t = await upstox.getToken();
  if (!t) return null;
  const res = await fetch('https://api.upstox.com/v2/charges/margin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ instruments: legs }),
  });
  const j = await res.json().catch(() => ({}));
  return res.ok && j.data ? Math.round(j.data.final_margin ?? j.data.required_margin) : null;
}

async function marginPerLot(symbol, setup, wing, lotSize, step) {
  try {
    const info = await instruments.resolve(symbol);
    const today = upstox.istDate(new Date());
    const expiry = info.expiries[0] === today && info.expiries[1] ? info.expiries[1] : info.expiries[0];
    const chain = await upstox.getOptionChain(info.underlyingKey, expiry);
    const spot = chain[0]?.underlying_spot_price;
    const atm = Math.round(spot / step) * step;
    const row = (k) => chain.find((r) => r.strike_price === k);
    if (setup === 'buyOrb') {
      const ltp = row(atm)?.call_options?.market_data?.ltp;
      return ltp ? Math.round(ltp * lotSize) : null;
    }
    const leg = (k, typ, side) => ({ instrument_key: row(k)?.[typ === 'CE' ? 'call_options' : 'put_options']?.instrument_key, quantity: lotSize, transaction_type: side, product: 'I' });
    const legs = [leg(atm, 'CE', 'SELL'), leg(atm, 'PE', 'SELL'), leg(atm + wing, 'CE', 'BUY'), leg(atm - wing, 'PE', 'BUY')];
    if (legs.some((l) => !l.instrument_key)) return null;
    return basketMargin(legs);
  } catch {
    return null;
  }
}

async function run(input = {}) {
  const symbol = String(input.symbol || 'NIFTY').toUpperCase();
  const cfg = optionData.SYMBOLS[symbol];
  if (!cfg) throw new HttpError(400, `Asli option backtest: ${Object.keys(optionData.SYMBOLS).join(', ')}`);
  const to = isDate(input.to) ? input.to : upstox.istDate(new Date());
  const from = isDate(input.from) ? input.from : upstox.istDate(Date.now() - 180 * 86400000);
  if (from > to) throw new HttpError(400, 'from date to se pehle honi chahiye');
  if (from < '2024-10-01') throw new HttpError(400, 'Expired option data Oct 2024 se available hai');

  const info = await instruments.resolve(symbol);
  const lotSize = num(input.lotSize, info?.lotSize || 1);
  const setup = input.setup === 'buyOrb' ? 'buyOrb' : 'ironFly';
  const params = {
    setup,
    lots: Math.max(1, parseInt(input.lots, 10) || 1),
    lotSize,
    step: cfg.step,
    brokeragePerOrder: config.rules.brokeragePerOrder,
    entryTime: /^\d{2}:\d{2}$/.test(input.entryTime || '') ? input.entryTime : '09:20',
    exitTime: /^\d{2}:\d{2}$/.test(input.exitTime || '') ? input.exitTime : '15:15',
    wing: num(input.wing, cfg.step * 6),
    slPct: num(input.slPct, 30),
    slMode: input.slMode === 'combined' ? 'combined' : 'leg',
    combinedSlPct: num(input.combinedSlPct, 50),
    slToCost: bool(input.slToCost, true),
    targetPct: num(input.targetPct, 0),
    onlyExpiryDay: bool(input.onlyExpiryDay, false),
    skipExpiryDay: bool(input.skipExpiryDay, false),
    orMinutes: num(input.orMinutes, 30),
    buySlPct: num(input.buySlPct, 25),
    buyTargetPct: num(input.buyTargetPct, 50),
  };

  const days = await optionData.loadDays(symbol, from, to);
  if (!days.length) throw new HttpError(422, 'Is range me market data nahi mila');
  const r = ob.run(days, params);
  const mpl = await marginPerLot(symbol, setup, params.wing, lotSize, cfg.step);
  const s = r.summary;
  const capital = mpl ? Math.round(mpl * params.lots + s.maxDrawdown) : null;
  return {
    symbol,
    from,
    to,
    params,
    summary: s,
    marginPerLot: mpl,
    capitalNeeded: capital, // margin + max drawdown jhelne ka buffer
    returnOnCapital: capital ? Math.round((s.net / capital) * 1000) / 10 : null,
    tradingDays: days.length,
    skipped: r.skipped.length,
    trades: r.trades,
  };
}

module.exports = { run, marginPerLot };
