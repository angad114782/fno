const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateOption } = require('../src/services/picksService');
const strategy = require('../src/services/strategy');

// 3-min option candles from 10:00 IST
const oc = (rows) => rows.map(([o, h, l, c], k) => ({ time: new Date(Date.UTC(2026, 8, 28, 4, 30) + k * 180000).toISOString(), open: o, high: h, low: l, close: c }));
const prm = strategy.withDefaults({ strategy: 'scalp' });
const lv = { entry: 100, stopLoss: 90, target1: 110, target2: 120 };

test('option chart: T1 pe aadha book + SL cost, phir T2', () => {
  const r = simulateOption(oc([[100, 104, 99, 103], [103, 111, 102, 109], [109, 121, 108, 120]]), 0, lv, prm, false);
  assert.equal(r.code, 'TP2');
  assert.equal(r.points, 15); // 0.5 x 10 + 0.5 x 20
});

test('option chart: SL pehle check hota hai, time stop 5 candle pe', () => {
  assert.equal(simulateOption(oc([[100, 112, 89, 95]]), 0, lv, prm, false).code, 'SL');
  const flat = oc(Array.from({ length: 8 }, () => [100, 102, 98, 99]));
  const r = simulateOption(flat, 0, lv, prm, false);
  assert.equal(r.code, 'TIME');
  assert.equal(r.points, -1);
  assert.equal(simulateOption(flat.slice(0, 3), 0, lv, prm, true).code, 'RUNNING');
});

test('option (index exits se): exit ke waqt option ka close, aadha-aadha book', () => {
  const { optionFromIndex } = require('../src/services/picksService');
  const c = oc([[100, 101, 99, 100], [100, 115, 99, 112], [112, 130, 110, 125]]);
  const t = { quantity: 2, exits: [{ time: c[1].time, quantity: 1 }, { time: c[2].time, quantity: 1 }] };
  const r = optionFromIndex(c, 0, t, { code: 'TP2', text: 'Target 2 hit', time: '10:06' }, false);
  assert.equal(r.points, 18.5); // 0.5 x 12 + 0.5 x 25
  assert.equal(r.viaIndex, true);
  const run = optionFromIndex(c, 0, { quantity: 2, exits: [] }, { code: 'RUNNING' }, true);
  assert.equal(run.code, 'RUNNING');
  assert.equal(run.ltp, 125);
});
