// Pure report calculations over an array of trades.
const { round2 } = require('./tradeEngine');

function dateKey(date, timeZone) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(date)
  );
}

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const wins = closed.filter((t) => t.result === 'WIN');
  const losses = closed.filter((t) => t.result === 'LOSS');
  const sum = (arr, k) => arr.reduce((s, t) => s + (t[k] || 0), 0);

  const grossProfit = sum(wins, 'netPnl');
  const grossLoss = Math.abs(sum(losses, 'netPnl'));
  const withR = closed.filter((t) => t.rMultiple != null);
  const withTp1 = closed.filter((t) => t.target1 != null);
  const withTp2 = closed.filter((t) => t.target2 != null);
  const withSl = closed.filter((t) => t.initialStopLoss != null);

  // Equity curve / max drawdown on closed trades ordered by exit time
  const ordered = [...closed].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of ordered) {
    equity += t.netPnl || 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  // Realised P&L of partially booked open trades
  const partialRealised = sum(
    trades.filter((t) => t.status === 'PARTIAL'),
    'grossPnl'
  );

  const pct = (n, d) => (d ? round2((n / d) * 100) : 0);

  return {
    totalTrades: trades.filter((t) => t.status !== 'CANCELLED').length,
    open: trades.filter((t) => t.status === 'OPEN').length,
    partial: trades.filter((t) => t.status === 'PARTIAL').length,
    closed: closed.length,
    cancelled: trades.filter((t) => t.status === 'CANCELLED').length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
    winRate: pct(wins.length, closed.length),
    grossPnl: round2(sum(closed, 'grossPnl')),
    charges: round2(sum(closed, 'charges')),
    netPnl: round2(sum(closed, 'netPnl')),
    partialRealisedPnl: round2(partialRealised),
    avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss ? round2(grossProfit / grossLoss) : grossProfit ? null : 0,
    expectancy: closed.length ? round2(sum(closed, 'netPnl') / closed.length) : 0,
    largestWin: wins.length ? round2(Math.max(...wins.map((t) => t.netPnl))) : 0,
    largestLoss: losses.length ? round2(Math.min(...losses.map((t) => t.netPnl))) : 0,
    avgR: withR.length ? round2(sum(withR, 'rMultiple') / withR.length) : null,
    maxDrawdown: round2(maxDrawdown),
    tp1HitRate: pct(withTp1.filter((t) => t.tp1Hit).length, withTp1.length),
    tp2HitRate: pct(withTp2.filter((t) => t.tp2Hit).length, withTp2.length),
    slHitRate: pct(withSl.filter((t) => t.slHit).length, withSl.length),
  };
}

function groupBy(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

function breakdown(trades, keyFn, keyName) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  return [...groupBy(closed, keyFn).entries()]
    .map(([key, list]) => {
      const s = summarize(list);
      return {
        [keyName]: key,
        trades: s.closed,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate,
        grossPnl: s.grossPnl,
        charges: s.charges,
        netPnl: s.netPnl,
      };
    })
    .sort((a, b) => (a[keyName] < b[keyName] ? -1 : a[keyName] > b[keyName] ? 1 : 0));
}

const daily = (trades, tz) => breakdown(trades, (t) => dateKey(t.exitTime, tz), 'date');
const monthly = (trades, tz) => breakdown(trades, (t) => dateKey(t.exitTime, tz).slice(0, 7), 'month');
const byUnderlying = (trades) => breakdown(trades, (t) => t.underlying, 'underlying');
const byStrategy = (trades) => breakdown(trades, (t) => t.strategy || 'NA', 'strategy');
const bySide = (trades) =>
  breakdown(trades, (t) => `${t.side} ${t.segment === 'OPT' ? t.optionType : 'FUT'}`, 'position');

module.exports = { dateKey, summarize, daily, monthly, byUnderlying, byStrategy, bySide };
