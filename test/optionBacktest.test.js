const test = require('node:test');
const assert = require('node:assert/strict');
const ob = require('../src/services/optionBacktest');

const times = [];
for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m += 5) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const series = (fn) => times.map((t, i) => {
  const v = fn(i, t);
  return { t, o: v, h: v, l: v, c: v, ...(typeof v === 'object' ? v : {}) };
});
const flat = (v) => series(() => v);

function day(legs, index = flat(25000)) {
  return { day: '2026-09-01', expiry: '2026-09-02', index, leg: (type, strike) => legs[`${type}_${strike}`] || null };
}
const P = { lotSize: 65, step: 50, brokeragePerOrder: 0 };

test('iron fly: flat market = credit decay profit, sab 15:15 pe exit', () => {
  // short legs 100 -> 60 (theta), wings 20 -> 10
  const decay = (a, b) => series((i) => a + ((b - a) * i) / (times.length - 1));
  const r = ob.run([day({ CE_25000: decay(100, 60), PE_25000: decay(100, 60), CE_25300: decay(20, 10), PE_24700: decay(20, 10) })], { ...P, wing: 300 });
  const t = r.trades[0];
  assert.equal(t.atm, 25000);
  assert.ok(t.legs.every((l) => l.reason === 'EXIT' && l.exitT === '15:15'));
  // entry at 09:20 open
  const ce = t.legs.find((l) => l.type === 'CE' && l.side === 'SELL');
  assert.ok(Math.abs(ce.entry - (100 - (40 * 1) / (times.length - 1))) < 0.01);
  assert.ok(t.gross > 0);
});

test('iron fly: CE leg SL hit, hedge band, PE SL cost pe', () => {
  const ce = series((i) => (i < 5 ? 100 : 140)); // 09:40 se 140 (> 130 SL)
  const pe = series((i) => (i < 5 ? 100 : i < 20 ? 70 : 100)); // baad me wapas 100 = cost
  const r = ob.run([day({ CE_25000: ce, PE_25000: pe, CE_25300: flat(20), PE_24700: flat(20) })], { ...P, wing: 300, slPct: 30, slToCost: true });
  const t = r.trades[0];
  const sCE = t.legs.find((l) => l.type === 'CE' && l.side === 'SELL');
  const sPE = t.legs.find((l) => l.type === 'PE' && l.side === 'SELL');
  assert.equal(sCE.reason, 'SL');
  assert.equal(sCE.exit, 140); // gap -> open pe fill
  assert.equal(t.legs.find((l) => l.type === 'CE' && l.side === 'BUY').reason, 'HEDGE_EXIT');
  assert.equal(sPE.reason, 'SL'); // cost pe SL
  assert.equal(sPE.exit, 100);
  assert.ok(t.events.some((e) => e.text.includes('cost')));
});

test('iron fly: data na ho to skip', () => {
  const r = ob.run([day({ CE_25000: flat(100) })], P);
  assert.equal(r.trades.length, 0);
  assert.match(r.skipped[0].reason, /data nahi/);
});

test('buy ORB: breakout ke baad ATM CE buy, target hit', () => {
  // index: 09:15-09:40 range 25000-25010, 09:45 close 25030 (breakout), entry 09:50 open
  const index = series((i) => (i < 6 ? 25005 : 25030)).map((c, i) => (i < 6 ? { ...c, h: 25010, l: 25000 } : c));
  const opt = series((i) => (i < 8 ? 100 : 160)); // entry 09:50 (i=7) @100, agla candle 160
  const r = ob.run([day({ CE_25050: opt, CE_25000: opt }, index)], { ...P, setup: 'buyOrb', orMinutes: 30, buySlPct: 25, buyTargetPct: 50 });
  const t = r.trades[0];
  assert.ok(t, JSON.stringify(r.skipped));
  const l = t.legs[0];
  assert.equal(l.type, 'CE');
  assert.equal(l.reason, 'TARGET');
  assert.equal(l.exit, 160); // gap above target -> open
  assert.equal(t.gross, (160 - 100) * 65);
});

test('stats: streak, drawdown, green months', () => {
  const s = ob.stats([
    { day: '2026-01-02', net: 500 },
    { day: '2026-01-05', net: -300 },
    { day: '2026-01-06', net: -300 },
    { day: '2026-02-02', net: 200 },
  ]);
  assert.equal(s.maxLossStreak, 2);
  assert.equal(s.maxDrawdown, 600);
  assert.equal(s.greenMonths, 1);
  assert.equal(s.net, 100);
});
