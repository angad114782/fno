// Upstox se apne aap: lot size, ATM delta, slippage (bid-ask spread), asli charges (brokerage API), capital (funds).
// User ko ye settings bharni nahi padti. 30 min cache.
const upstox = require('./upstox');
const instruments = require('./instruments');
const { round2 } = require('./tradeEngine');

const cache = new Map(); // `${symbol}|${lots}` -> { at, value }
const TTL = 30 * 60000;

async function brokerage(instrumentKey, quantity, price, side) {
  const r = await upstox.request('/v2/charges/brokerage', {
    query: { instrument_token: instrumentKey, quantity, product: 'I', transaction_type: side, price },
  });
  return r?.charges || null;
}

function nearestExpiry(info) {
  const today = upstox.istDate(new Date());
  return info.expiries[0] === today && info.expiries[1] ? info.expiries[1] : info.expiries[0];
}

/**
 * { lotSize, delta, slippagePts, charges: { perOrderFixed, variableRoundTrip, roundTrip }, source, notes[] }
 * Upstox na mile to safe defaults.
 */
async function forSymbol(symbol, lots = 1) {
  const key = `${String(symbol).toUpperCase()}|${lots}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const info = await instruments.resolve(symbol);
  const out = {
    symbol: String(symbol).toUpperCase(),
    lotSize: info?.lotSize || null,
    delta: 0.5,
    slippagePts: 1,
    charges: { perOrderFixed: 35.4, variableRoundTrip: 20, roundTrip: 90.8 },
    source: 'default',
    notes: [],
  };
  if (!info || !info.hasFno || !info.expiries.length) {
    out.notes.push('F&O data nahi mila - default values');
    return out;
  }
  try {
    const expiry = nearestExpiry(info);
    const chain = await upstox.getOptionChain(info.underlyingKey, expiry);
    const spot = chain[0]?.underlying_spot_price;
    const atm = chain.reduce((b, r) => (!b || Math.abs(r.strike_price - spot) < Math.abs(b.strike_price - spot) ? r : b), null);
    const legs = [atm?.call_options, atm?.put_options].filter((l) => l?.market_data?.ltp);
    if (legs.length) {
      const deltas = legs.map((l) => Math.abs(l.option_greeks?.delta || 0)).filter((d) => d > 0.1 && d < 0.95);
      if (deltas.length) out.delta = round2(deltas.reduce((s, d) => s + d, 0) / deltas.length);
      // Slippage: har order pe poora bid-ask spread (conservative), underlying points me
      const spreads = legs.map((l) => l.market_data.ask_price - l.market_data.bid_price).filter((x) => x > 0 && x < l0(legs));
      if (spreads.length) {
        const spread = spreads.reduce((s, x) => s + x, 0) / spreads.length;
        out.slippagePts = round2(Math.max(0.5, spread / out.delta));
      }
      // Asli charges: 1 buy + 1 sell (Upstox brokerage API)
      const leg = legs[0];
      const qty = (info.lotSize || 1) * lots;
      const [b, s] = await Promise.all([
        brokerage(leg.instrument_key, qty, leg.market_data.ltp, 'BUY'),
        brokerage(leg.instrument_key, qty, leg.market_data.ltp, 'SELL'),
      ]);
      if (b && s) {
        const fixed = (x) => (x.brokerage || 0) * 1.18; // brokerage + GST (har order)
        const perOrderFixed = round2((fixed(b) + fixed(s)) / 2);
        const roundTrip = round2(b.total + s.total);
        out.charges = { perOrderFixed, variableRoundTrip: round2(roundTrip - 2 * perOrderFixed), roundTrip, buy: b.total, sell: s.total };
      }
      out.source = 'upstox';
      out.premium = leg.market_data.ltp;
      out.expiry = expiry;
    }
  } catch (err) {
    if (err.status === 424) throw err;
    out.notes.push(`Upstox se nahi mila (${err.message}) - default values`);
  }
  cache.set(key, { at: Date.now(), value: out });
  return out;
}

// spread sanity: premium ke 10% se zyada spread ignore
function l0(legs) {
  return Math.min(...legs.map((l) => l.market_data.ltp)) * 0.1;
}

// Upstox funds (trading balance). Weekend/holiday pe 0 aa sakta hai -> null
async function capital() {
  try {
    const f = await upstox.request('/v2/user/get-funds-and-margin');
    const eq = f?.equity || {};
    const total = (Number(eq.available_margin) || 0) + (Number(eq.used_margin) || 0);
    return total > 0 ? round2(total) : null;
  } catch {
    return null;
  }
}

module.exports = { forSymbol, capital };
