// Pure analysis of broker (Upstox) P&L report rows - "mera asli record".
// Row: { scrip_name, trade_type, quantity, buy_date, sell_date (dd-mm-yyyy), buy_average, sell_average, buy_amount, sell_amount }

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const r0 = (n) => Math.round(n);
const dmy = (s) => {
  const [dd, mm, yy] = String(s).split('-').map(Number);
  return new Date(Date.UTC(yy, mm - 1, dd));
};
const dayKey = (d) => d.toISOString().slice(0, 10);

// Andaza (Upstox P&L report me charges nahi hote): brokerage Rs20/order, STT, exchange txn, GST, stamp
function estimateCharges({ trade_type: type, buy_amount: buy, sell_amount: sell }, brokeragePerOrder = 20) {
  const txn = (type === 'FUT' ? 0.00002 : 0.00035) * (buy + sell);
  const brok = brokeragePerOrder * 2;
  const stt = type === 'OPT' ? 0.001 * sell : type === 'FUT' ? 0.0002 * sell : 0.001 * (buy + sell);
  return brok + stt + txn + 0.18 * (brok + txn) + 0.00003 * buy;
}

function normalize(row, brokeragePerOrder) {
  const m = String(row.scrip_name).match(/^(\S+)\s+(\d{1,2}) (\w{3}) (\d{4})\s+(CE|PE|FUT)?\s*([\d.]+)?/);
  const expiry = m && MON[m[3]] != null ? new Date(Date.UTC(+m[4], MON[m[3]], +m[2])) : null;
  const buy = dmy(row.buy_date);
  const sell = dmy(row.sell_date);
  const short = sell < buy;
  const entry = short ? sell : buy;
  const gross = row.sell_amount - row.buy_amount;
  const charges = estimateCharges(row, brokeragePerOrder);
  return {
    name: row.scrip_name,
    symbol: m ? m[1] : row.scrip_name,
    optionType: m ? m[5] || row.trade_type : row.trade_type,
    strike: m && m[6] ? Number(m[6]) : null,
    expiry,
    entry,
    day: dayKey(entry),
    side: short ? 'SELL' : 'BUY',
    qty: row.quantity,
    premium: short ? row.sell_average : row.buy_average,
    gross,
    charges,
    net: gross - charges,
    expiryDay: Boolean(expiry) && +expiry === +entry,
    overnight: +buy !== +sell,
  };
}

function stats(list) {
  const wins = list.filter((x) => x.net > 0);
  const losses = list.filter((x) => x.net <= 0);
  const sw = wins.reduce((s, x) => s + x.net, 0);
  const sl = -losses.reduce((s, x) => s + x.net, 0);
  return {
    trades: list.length,
    winRate: list.length ? +((100 * wins.length) / list.length).toFixed(1) : 0,
    gross: r0(list.reduce((s, x) => s + x.gross, 0)),
    charges: r0(list.reduce((s, x) => s + x.charges, 0)),
    net: r0(sw - sl),
    avgWin: wins.length ? r0(sw / wins.length) : 0,
    avgLoss: losses.length ? r0(-sl / losses.length) : 0,
    profitFactor: sl ? +(sw / sl).toFixed(2) : null,
  };
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const breakdown = (list, keyFn) => [...groupBy(list, keyFn)].map(([key, l]) => ({ key, ...stats(l) }));

const premiumBucket = (p) => (p < 20 ? 'Rs 20 se kam' : p < 50 ? 'Rs 20-50' : p < 100 ? 'Rs 50-100' : p < 200 ? 'Rs 100-200' : 'Rs 200+');
const tradesBucket = (n) => (n <= 2 ? '1-2 trades' : n <= 5 ? '3-5 trades' : n <= 9 ? '6-9 trades' : '10+ trades');

// Rule: din me max N trades, M loss ke baad band -> kitna bachta
function simulateDailyRule(trades, maxTrades, maxLosses) {
  let net = 0;
  let taken = 0;
  for (const list of groupBy(trades, (x) => x.day).values()) {
    let n = 0;
    let l = 0;
    for (const x of list) {
      if (n >= maxTrades || l >= maxLosses) break;
      net += x.net;
      n += 1;
      taken += 1;
      if (x.net < 0) l += 1;
    }
  }
  return { maxTrades, maxLosses, net: r0(net), trades: taken };
}

function analyze(rows, { brokeragePerOrder = 20 } = {}) {
  const trades = rows.map((r) => normalize(r, brokeragePerOrder)).sort((a, b) => a.entry - b.entry);
  if (!trades.length) return { summary: stats([]), trades: 0 };

  const days = breakdown(trades, (x) => x.day).map((d) => ({ ...d, day: d.key }));
  const dayTradeCount = new Map(days.map((d) => [d.day, d.trades]));
  let eq = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const x of trades) {
    eq += x.net;
    peak = Math.max(peak, eq);
    maxDrawdown = Math.max(maxDrawdown, peak - eq);
  }

  const summary = { ...stats(trades), maxDrawdown: r0(maxDrawdown), from: trades[0].day, to: trades[trades.length - 1].day, tradingDays: days.length };
  const byTradesPerDay = breakdown(trades, (x) => tradesBucket(dayTradeCount.get(x.day)));
  const byExpiryDay = breakdown(trades, (x) => (x.expiryDay ? 'Expiry day' : 'Normal day'));
  const byPremium = breakdown(trades, (x) => premiumBucket(x.premium));
  const worstDays = days.slice().sort((a, b) => a.net - b.net).slice(0, 5);
  const maxTradesDay = days.reduce((m, d) => (d.trades > m.trades ? d : m), days[0]);

  // Insights: sabse bade leak, rupaye me
  const insights = [];
  if (summary.charges > Math.abs(summary.gross) * 0.5 || summary.charges > summary.gross) {
    insights.push({ key: 'charges', text: `Charges ~Rs ${summary.charges} (andaza) - ${summary.gross < 0 ? 'gross loss se bhi' : 'gross profit ka bada hissa'}. Kam trades = kam charges.` });
  }
  const heavy = byTradesPerDay.find((b) => b.key === '10+ trades');
  if (heavy && heavy.net < 0) insights.push({ key: 'overtrading', text: `Jin dino 10+ trades kiye, unka net Rs ${heavy.net}. Avg ${(trades.length / days.length).toFixed(1)} trades/din, max ${maxTradesDay.trades} (${maxTradesDay.day}).` });
  const exp = byExpiryDay.find((b) => b.key === 'Expiry day');
  if (exp && exp.net < 0 && exp.trades >= trades.length * 0.3) insights.push({ key: 'expiry', text: `${Math.round((100 * exp.trades) / trades.length)}% trades expiry day pe, net Rs ${exp.net}.` });
  const cheap = byPremium.find((b) => b.key === 'Rs 20 se kam');
  if (cheap && cheap.net < 0 && cheap.trades >= 10) insights.push({ key: 'cheap', text: `Rs 20 se sasti options (lottery): ${cheap.trades} trades, win ${cheap.winRate}%, net Rs ${cheap.net}.` });
  if (worstDays[0] && worstDays[0].net < 0) insights.push({ key: 'worstDay', text: `Sabse bura din ${worstDays[0].day}: ${worstDays[0].trades} trades, Rs ${worstDays[0].net}.` });

  const whatIf = [simulateDailyRule(trades, 2, 2), simulateDailyRule(trades, 1, 1), simulateDailyRule(trades, 3, 2)];

  return {
    summary,
    insights,
    whatIf,
    byYear: breakdown(trades, (x) => x.day.slice(0, 4)).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byMonth: breakdown(trades, (x) => x.day.slice(0, 7)).sort((a, b) => (a.key < b.key ? 1 : -1)),
    bySymbol: breakdown(trades, (x) => x.symbol).sort((a, b) => b.trades - a.trades),
    byType: breakdown(trades, (x) => `${x.side} ${x.optionType}`),
    byExpiryDay,
    byPremium,
    byTradesPerDay,
    worstDays,
    bestDays: days.slice().sort((a, b) => b.net - a.net).slice(0, 5),
  };
}

module.exports = { analyze, normalize, estimateCharges, simulateDailyRule };
