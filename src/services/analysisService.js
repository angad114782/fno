// Live analysis: Upstox candles + option chain -> strategy signal -> option trade suggestion.
const config = require('../config/env');
const upstox = require('./upstox');
const instruments = require('./instruments');
const strategy = require('./strategy');
const backtest = require('./backtest');
const riskService = require('./riskService');
const autoDefaults = require('./autoDefaults');
const { istParts } = require('./indicators');
const { round2 } = require('./tradeEngine');
const HttpError = require('../utils/httpError');

const tick = (n) => Math.max(0.05, Math.round(n * 20) / 20);

function marketState(now = new Date()) {
  const { day, minutes } = istParts(now);
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekday = wd >= 1 && wd <= 5;
  return { day, minutes, open: weekday && minutes >= 555 && minutes < 930 }; // 09:15 - 15:30 IST
}

// Sirf closed candles (last candle abhi ban raha ho to hata do)
function closedOnly(candles, intervalMin, now = Date.now()) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  return new Date(last.time).getTime() + intervalMin * 60000 > now ? candles.slice(0, -1) : candles;
}

function chainStats(chain) {
  let callOi = 0;
  let putOi = 0;
  let maxCall = null;
  let maxPut = null;
  for (const row of chain) {
    const c = row.call_options?.market_data?.oi || 0;
    const p = row.put_options?.market_data?.oi || 0;
    callOi += c;
    putOi += p;
    if (!maxCall || c > maxCall.oi) maxCall = { strike: row.strike_price, oi: c };
    if (!maxPut || p > maxPut.oi) maxPut = { strike: row.strike_price, oi: p };
  }
  return {
    pcr: callOi ? round2(putOi / callOi) : null,
    totalCallOi: callOi,
    totalPutOi: putOi,
    resistance: maxCall?.strike ?? null, // sabse zyada Call OI
    support: maxPut?.strike ?? null, // sabse zyada Put OI
  };
}

function atmRow(chain, spot) {
  return chain.reduce((best, r) => (!best || Math.abs(r.strike_price - spot) < Math.abs(best.strike_price - spot) ? r : best), null);
}

function optionPlan(sig, row, info, expiry, p, riskPerTrade, charges) {
  const isCall = sig.direction === 'LONG';
  const leg = isCall ? row.call_options : row.put_options;
  const premium = leg?.market_data?.ltp;
  if (!premium) return { error: 'ATM option ka LTP nahi mila' };
  const delta = Math.abs(leg.option_greeks?.delta || 0.5) || 0.5;
  const move = (r) => delta * sig.riskPts * r;
  const stopLoss = tick(premium - move(1));
  const plan = {
    underlying: info.symbol,
    segment: 'OPT',
    optionType: isCall ? 'CE' : 'PE',
    strike: row.strike_price,
    expiry,
    side: 'BUY',
    instrumentKey: leg.instrument_key,
    entryPrice: premium,
    stopLoss,
    target1: tick(premium + move(p.tp1R)),
    target2: p.tp1BookAll ? null : tick(premium + move(p.tp2R)),
    delta: round2(delta),
    iv: leg.option_greeks?.iv ?? null,
    lotSize: info.lotSize,
    strategy: strategy.STRATEGIES[p.strategy] || p.strategy,
  };
  if (stopLoss >= premium || stopLoss <= premium * 0.2) {
    return { ...plan, error: 'Premium ke hisaab se SL sahi nahi ban raha (bahut sasta/volatile option)' };
  }
  const riskPerLot = (premium - stopLoss) * info.lotSize;
  plan.riskPerLot = round2(riskPerLot);
  // SL hit pe total nuksaan = lots x risk + charges (Upstox brokerage API se). Lots isi hisaab se.
  const fixed = 2 * charges.perOrderFixed;
  const variable = charges.variableRoundTrip;
  plan.lots = Math.max(0, Math.floor((riskPerTrade - fixed) / (riskPerLot + variable)));
  plan.charges = round2(fixed + variable * Math.max(plan.lots, 1));
  plan.maxLoss = round2(plan.lots * riskPerLot + (plan.lots ? plan.charges : 0));
  plan.capitalNeeded = round2(plan.lots * premium * info.lotSize);
  return plan;
}

async function riskSafe() {
  try {
    return await riskService.status();
  } catch (err) {
    const rules = await riskService.getRules();
    return { state: 'OK', reasons: [], rules: { ...rules, ...riskService.derived(rules) }, errors: [err.message] };
  }
}

async function analyze(symbol, { interval = config.signals.intervalMin, params = {}, risk } = {}) {
  const rk = risk || (await riskSafe());
  const info = await instruments.resolve(symbol);
  if (!info) throw new HttpError(404, `"${symbol}" Upstox instruments me nahi mila`);
  const p = strategy.withDefaults(params);
  const iv = Number(interval) || 5;

  const to = upstox.istDate(new Date());
  // ~45 din: indicators warm-up + auto-pause ke liye strategy ke recent signals ka record
  const from = upstox.istDate(Date.now() - (iv <= 3 ? 10 : 45) * 86400000);
  const all = await upstox.getCandles(info.underlyingKey, { unit: 'minutes', interval: iv, from, to });
  const candles = closedOnly(all, iv);
  if (candles.length < 40) throw new HttpError(422, `Candles kam hain (${candles.length}) - analysis nahi ho sakta`);

  const series = strategy.computeIndicators(candles, p);
  const last = candles.length - 1;
  const sig = strategy.evaluateAt(candles, series, last, p);
  const mkt = marketState();

  // Auto-pause: strategy ke recent signals (1 lot option approx) ka net loss me hai?
  let pause = null;
  if (p.pauseLookback > 0) {
    const bt = backtest.run(candles, p, {
      mode: 'OPTION',
      delta: 0.5,
      lots: 1,
      lotSize: info.lotSize || 1,
      brokeragePerOrder: config.rules.brokeragePerOrder,
      slippagePts: 1,
      underlying: info.symbol,
    });
    pause = bt.pauseState;
  }
  const lastDay = istParts(candles[last].time).day;

  // Aaj (last session) ke saare fresh signals - review ke liye
  const todaySignals = [];
  for (let i = 1; i < candles.length; i++) {
    if (istParts(candles[i].time).day !== lastDay) continue;
    const s = strategy.evaluateAt(candles, series, i, p);
    if (s.direction && s.fresh) todaySignals.push({ time: s.time, direction: s.direction, score: s.score, entry: s.entry, inWindow: s.inWindow });
  }

  const result = {
    symbol: info.symbol,
    type: info.type,
    lotSize: info.lotSize,
    interval: iv,
    market: mkt,
    lastCandle: candles[last],
    spot: candles[last].close,
    signal: sig,
    pause,
    risk: rk,
    todaySignals,
    warnings: [],
    option: null,
    chain: null,
  };

  if (info.hasFno && info.expiries.length) {
    // Expiry ke din: rule ON ho to next expiry (aaj expire hone wale option me theta bahut tez), warna 1 baje ke baad
    let expiry = info.expiries[0];
    if (expiry === mkt.day && info.expiries[1] && (rk.rules.noExpiryDay || mkt.minutes >= 13 * 60)) expiry = info.expiries[1];
    try {
      const chain = await upstox.getOptionChain(info.underlyingKey, expiry);
      if (chain.length) {
        const spot = chain[0].underlying_spot_price || result.spot;
        result.spot = spot;
        result.chain = { expiry, ...chainStats(chain), atmStrike: atmRow(chain, spot).strike_price };
        if (sig.direction) {
          const auto = await autoDefaults.forSymbol(info.symbol, 1).catch(() => null);
          const charges = auto?.charges || { perOrderFixed: 35.4, variableRoundTrip: 20 };
          result.option = optionPlan(sig, atmRow(chain, spot), info, expiry, p, rk.rules.riskPerTrade, charges);
        }
      }
    } catch (err) {
      if (err.status === 424) throw err;
      result.warnings.push(`Option chain nahi mila: ${err.message}`);
    }
  } else if (!info.hasFno) {
    result.warnings.push('Is stock me F&O nahi hai - sirf analysis');
  }

  // Warnings / filters
  const c = result.chain;
  if (sig.direction && c) {
    const near = (lvl) => lvl != null && Math.abs(result.spot - lvl) <= sig.riskPts;
    if (sig.direction === 'LONG' && near(c.resistance) && result.spot <= c.resistance) {
      result.warnings.push(`Price ${c.resistance} (sabse zyada Call OI = resistance) ke paas hai - upar jaana mushkil ho sakta hai`);
    }
    if (sig.direction === 'SHORT' && near(c.support) && result.spot >= c.support) {
      result.warnings.push(`Price ${c.support} (sabse zyada Put OI = support) ke paas hai - neeche jaana mushkil ho sakta hai`);
    }
    if (c.expiry === mkt.day) result.warnings.push('Aaj expiry hai - premium bahut tezi se girta hai, chhota size rakho');
  }
  if (result.option && result.option.lots === 0) {
    result.warnings.push(`1 lot ka risk (Rs ${result.option.riskPerLot}) aapke risk limit (capital ka ${rk.rules.riskPct}% = Rs ${rk.rules.riskPerTrade}) se zyada hai - trade skip karo`);
  }

  if (pause?.paused) {
    result.warnings.push(`Auto-pause ON: strategy ke pichhle ${pause.recentTrades} signals ka net -₹${Math.abs(pause.recentNet)} (loss) hai. Kharab phase - naye signal sirf paper pe track karo`);
  }

  // Final verdict
  let action = 'WAIT';
  let why = sig.reason;
  if (!mkt.open) why = `Market band hai. ${sig.direction ? `Last signal: ${sig.direction} (${sig.reason})` : sig.reason}`;
  else if (sig.direction && sig.fresh && sig.inWindow && result.option && !result.option.error && result.option.lots > 0) {
    action = sig.direction === 'LONG' ? 'BUY CE' : 'BUY PE';
    why = `${sig.score}/${sig.maxScore} checks ${sig.direction === 'LONG' ? 'bullish' : 'bearish'}${sig.strict ? ' + saare strict filters pass' : ''}`;
    if (pause?.paused) {
      action = `PAPER ONLY (${action})`;
      why = 'Signal aaya par auto-pause ON hai - real paisa mat lagao, sirf note karo';
    }
  } else if (sig.direction && result.option?.error) why = result.option.error;
  // Capital protection sabse upar: limit hit -> STOP
  if (rk.state !== 'OK') {
    action = 'STOP';
    why = rk.reasons.join(' ');
  }
  result.verdict = { action, why };
  return result;
}

async function scan(symbols, opts = {}) {
  const out = [];
  const risk = await riskSafe();
  opts = { ...opts, risk };
  for (const s of symbols) {
    try {
      const r = await analyze(s, opts);
      out.push({
        symbol: r.symbol,
        spot: r.spot,
        action: r.verdict.action,
        why: r.verdict.why,
        direction: r.signal.direction,
        score: r.signal.direction ? r.signal.score : Math.max(r.signal.longScore || 0, r.signal.shortScore || 0),
        longScore: r.signal.longScore,
        shortScore: r.signal.shortScore,
        rsi: r.signal.rsi,
        pcr: r.chain?.pcr ?? null,
        option: r.option,
        time: r.lastCandle.time,
      });
    } catch (err) {
      if (err.status === 424) throw err;
      out.push({ symbol: s, error: err.message });
    }
  }
  const rank = (x) => (x.error ? 3 : x.action !== 'WAIT' ? 0 : x.direction ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (b.score || 0) - (a.score || 0));
}

module.exports = { analyze, scan, marketState, closedOnly, chainStats };
