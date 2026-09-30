const test = require('node:test');
const assert = require('node:assert/strict');
const brokerStats = require('../src/services/brokerStats');
const { derived, fyCode } = require('../src/services/riskService');

const row = (o) => ({
  scrip_name: 'NIFTY 10 Mar 2026 PE 23850',
  trade_type: 'OPT',
  quantity: 65,
  buy_date: '09-03-2026',
  sell_date: '09-03-2026',
  buy_average: 100,
  sell_average: 110,
  buy_amount: 6500,
  sell_amount: 7150,
  ...o,
});

test('normalize: scrip name parse, expiry day, charges', () => {
  const t = brokerStats.normalize(row({ buy_date: '10-03-2026', sell_date: '10-03-2026' }), 20);
  assert.equal(t.symbol, 'NIFTY');
  assert.equal(t.optionType, 'PE');
  assert.equal(t.strike, 23850);
  assert.equal(t.expiryDay, true);
  assert.equal(t.side, 'BUY');
  assert.equal(t.gross, 650);
  assert.ok(t.charges > 40 && t.charges < 80, `charges ${t.charges}`);
  assert.ok(Math.abs(t.net - (650 - t.charges)) < 1e-9);
});

test('analyze: summary, overtrading insight, daily-rule what-if', () => {
  const rows = [];
  // din 1: 12 chhote loss (overtrading)
  for (let i = 0; i < 12; i++) rows.push(row({ buy_date: '05-03-2026', sell_date: '05-03-2026', sell_amount: 6400, sell_average: 98.46 }));
  // din 2: 1 badi jeet
  rows.push(row({ buy_date: '06-03-2026', sell_date: '06-03-2026', sell_amount: 8500, sell_average: 130.77 }));
  const r = brokerStats.analyze(rows);
  assert.equal(r.summary.trades, 13);
  assert.equal(r.summary.tradingDays, 2);
  assert.ok(r.insights.some((i) => i.key === 'overtrading'));
  const twoPerDay = r.whatIf.find((w) => w.maxTrades === 2 && w.maxLosses === 2);
  assert.equal(twoPerDay.trades, 3); // din 1 pe sirf 2, din 2 pe 1
  assert.ok(twoPerDay.net > r.summary.net, 'rule se loss kam hona chahiye');
});

test('risk rules: limits capital se', () => {
  const d = derived({ capital: 30000, riskPct: 1.5, dailyLossPct: 3, monthlyLossPct: 10 });
  assert.deepEqual(d, { riskPerTrade: 450, dailyLossLimit: 900, monthlyLossLimit: 3000 });
});

test('financial year code', () => {
  assert.equal(fyCode('2026-03-31'), '2526');
  assert.equal(fyCode('2026-04-01'), '2627');
  assert.equal(fyCode('2026-09-27'), '2627');
});
