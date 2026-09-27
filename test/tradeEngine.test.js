const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/tradeEngine');
const reports = require('../src/services/reportEngine');

const opts = { tp1ExitPercent: 50, moveSlToCostOnTp1: true, brokeragePerOrder: 20 };

function makeTrade(over = {}) {
  const t = {
    underlying: 'nifty',
    instrumentType: 'INDEX',
    segment: 'OPT',
    optionType: 'CE',
    strike: 25000,
    expiry: '2026-10-27',
    side: 'BUY',
    lotSize: 65,
    lots: 2,
    entryPrice: 150,
    stopLoss: 120,
    target1: 190,
    target2: 240,
    ...over,
  };
  engine.initTrade(t);
  engine.recompute(t, opts);
  return t;
}

test('trading symbol format', () => {
  assert.equal(makeTrade().tradingSymbol, 'NIFTY 27OCT26 25000 CE');
  assert.equal(makeTrade({ segment: 'FUT', strike: null, optionType: null }).tradingSymbol, 'NIFTY 27OCT26 FUT');
});

test('validateLevels BUY and SELL', () => {
  assert.deepEqual(engine.validateLevels({ side: 'BUY', entryPrice: 100, stopLoss: 90, target1: 110, target2: 120 }), []);
  assert.equal(engine.validateLevels({ side: 'BUY', entryPrice: 100, stopLoss: 105 }).length, 1);
  assert.equal(engine.validateLevels({ side: 'BUY', entryPrice: 100, target1: 110, target2: 105 }).length, 1);
  assert.deepEqual(engine.validateLevels({ side: 'SELL', entryPrice: 100, stopLoss: 110, target1: 90, target2: 80 }), []);
  assert.equal(engine.validateLevels({ side: 'SELL', entryPrice: 100, stopLoss: 90, target1: 110 }).length, 2);
});

test('validateContract requires option fields', () => {
  const errs = engine.validateContract({ underlying: 'NIFTY', segment: 'OPT', side: 'BUY', expiry: '2026-10-27', lots: 1, lotSize: 65 });
  assert.ok(errs.some((e) => e.includes('optionType')));
  assert.ok(errs.some((e) => e.includes('strike')));
});

test('risk reward and quantity', () => {
  const t = makeTrade();
  assert.equal(t.quantity, 130);
  assert.equal(t.riskPerUnit, 30);
  assert.equal(t.rrTp1, 1.33);
  assert.equal(t.rrTp2, 3);
});

test('BUY: TP1 books half, SL to cost, TP2 books rest', () => {
  const t = makeTrade();
  let ev = engine.onPriceUpdate(t, 170, opts);
  assert.equal(ev.length, 0);
  assert.equal(t.status, 'OPEN');

  ev = engine.onPriceUpdate(t, 191, opts);
  assert.equal(ev[0].type, 'TP1_HIT');
  assert.equal(t.openQuantity, 65);
  assert.equal(t.stopLoss, 150);
  assert.equal(t.status, 'PARTIAL');
  assert.equal(t.grossPnl, 40 * 65);

  ev = engine.onPriceUpdate(t, 245, opts);
  assert.equal(ev[0].type, 'TP2_HIT');
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.grossPnl, 40 * 65 + 90 * 65);
  assert.equal(t.charges, 60); // entry + 2 exits
  assert.equal(t.netPnl, 8450 - 60);
  assert.equal(t.result, 'WIN');
  assert.equal(t.avgExitPrice, 215);
  assert.equal(t.rMultiple, 2.17);
});

test('BUY: SL hit exits full qty at LTP', () => {
  const t = makeTrade();
  const ev = engine.onPriceUpdate(t, 118, opts);
  assert.equal(ev[0].type, 'SL_HIT');
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.slHit, true);
  assert.equal(t.grossPnl, -32 * 130);
  assert.equal(t.result, 'LOSS');
});

test('BUY: trail SL at cost after TP1', () => {
  const t = makeTrade();
  engine.onPriceUpdate(t, 190, opts);
  const ev = engine.onPriceUpdate(t, 150, opts);
  assert.equal(ev[0].type, 'TRAIL_SL_HIT');
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.grossPnl, 40 * 65);
});

test('gap through TP1 and TP2 in one tick', () => {
  const t = makeTrade();
  const ev = engine.onPriceUpdate(t, 300, opts);
  assert.deepEqual(ev.map((e) => e.type), ['TP1_HIT', 'TP2_HIT']);
  assert.equal(t.status, 'CLOSED');
});

test('single lot: TP1 only marks + trails SL', () => {
  const t = makeTrade({ lots: 1 });
  const ev = engine.onPriceUpdate(t, 195, opts);
  assert.equal(ev[0].type, 'TP1_HIT');
  assert.equal(ev[0].exit, null);
  assert.equal(t.openQuantity, 65);
  assert.equal(t.stopLoss, 150);
});

test('no TP2: TP1 books everything', () => {
  const t = makeTrade({ target2: null });
  engine.onPriceUpdate(t, 190, opts);
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.grossPnl, 40 * 130);
});

test('SELL futures: SL above, targets below', () => {
  const t = makeTrade({
    underlying: 'BANKNIFTY', segment: 'FUT', optionType: null, strike: null, side: 'SELL',
    lotSize: 30, lots: 2, entryPrice: 52000, stopLoss: 52200, target1: 51700, target2: 51400,
  });
  let ev = engine.onPriceUpdate(t, 51650, opts);
  assert.equal(ev[0].type, 'TP1_HIT');
  assert.equal(t.grossPnl, 300 * 30);
  assert.equal(t.stopLoss, 52000);
  ev = engine.onPriceUpdate(t, 52010, opts);
  assert.equal(ev[0].type, 'TRAIL_SL_HIT');
  assert.equal(t.grossPnl, 300 * 30 - 10 * 30);
});

test('manual exit validation', () => {
  const t = makeTrade();
  assert.throws(() => engine.applyExit(t, { price: 160, quantity: 50 }, opts), /multiple of lot size/);
  assert.throws(() => engine.applyExit(t, { price: 160, quantity: 195 }, opts), /open quantity/);
  engine.applyExit(t, { price: 160, quantity: 65 }, opts);
  assert.equal(t.status, 'PARTIAL');
  engine.applyExit(t, { price: 170 }, opts);
  assert.equal(t.status, 'CLOSED');
  assert.throws(() => engine.applyExit(t, { price: 170 }, opts), /CLOSED/);
});

test('validateModify allows trailing SL into profit', () => {
  const t = makeTrade();
  engine.onPriceUpdate(t, 200, opts);
  assert.deepEqual(engine.validateModify(t, { stopLoss: 180 }), []);
  assert.equal(engine.validateModify(t, { stopLoss: 205 }).length > 0, true);
});

test('cancel only open trade', () => {
  const t = makeTrade();
  engine.cancelTrade(t, opts);
  assert.equal(t.status, 'CANCELLED');
  assert.equal(t.charges, 0);
  assert.equal(engine.onPriceUpdate(t, 100, opts).length, 0);
});

test('report summary and daily grouping', () => {
  const a = makeTrade();
  engine.onPriceUpdate(a, 250, { ...opts, time: new Date('2026-09-25T05:00:00Z') });
  const b = makeTrade();
  engine.onPriceUpdate(b, 100, { ...opts, time: new Date('2026-09-25T20:00:00Z') }); // 26 Sep IST
  const c = makeTrade();
  const s = reports.summarize([a, b, c]);
  assert.equal(s.closed, 2);
  assert.equal(s.open, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.winRate, 50);
  assert.equal(s.netPnl, a.netPnl + b.netPnl);
  assert.equal(s.tp1HitRate, 50);
  assert.equal(s.slHitRate, 50);
  const d = reports.daily([a, b], 'Asia/Kolkata');
  assert.deepEqual(d.map((x) => x.date), ['2026-09-25', '2026-09-26']);
});
