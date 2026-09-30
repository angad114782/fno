// Upstox status, analysis/signals, backtest
const router = require('express').Router();
const config = require('../config/env');
const upstox = require('../services/upstox');
const instruments = require('../services/instruments');
const analysis = require('../services/analysisService');
const live = require('../services/liveService');
const bt = require('../services/backtestService');
const strategy = require('../services/strategy');
const risk = require('../services/riskService');
const broker = require('../services/brokerService');
const autoDefaults = require('../services/autoDefaults');
const optBt = require('../services/optionBacktestService');
const picks = require('../services/picksService');
const paper = require('../services/paperService');
const ah = require('../utils/asyncHandler');

const pickParams = (q) => (q.strategy && strategy.STRATEGIES[q.strategy] ? { strategy: q.strategy } : {});

router.get(
  '/upstox/status',
  ah(async (req, res) =>
    res.json({
      ...(await upstox.status()),
      market: analysis.marketState(),
      live: live.state,
      watchlist: config.signals.watchlist,
    })
  )
);
router.post('/upstox/logout', ah(async (req, res) => res.json({ ok: true, ...(await upstox.logout()) })));

router.get('/symbols', ah(async (req, res) => res.json(await instruments.search(req.query.q, Number(req.query.limit) || 30))));

// Watchlist / list scan: /api/signals?symbols=NIFTY,BANKNIFTY,RELIANCE
router.get(
  '/signals',
  ah(async (req, res) => {
    const symbols = req.query.symbols
      ? String(req.query.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 25)
      : config.signals.watchlist;
    res.json(await analysis.scan(symbols, { interval: req.query.interval, params: pickParams(req.query) }));
  })
);

router.get('/analysis/:symbol', ah(async (req, res) => res.json(await analysis.analyze(req.params.symbol, { interval: req.query.interval, params: pickParams(req.query) }))));

// Open trades ka LTP abhi turant Upstox se
router.post('/live/poll', ah(async (req, res) => res.json({ updated: await live.pollOpenTrades() })));

// Capital protection
router.get('/risk', ah(async (req, res) => res.json(await risk.status())));
router.put('/risk/rules', ah(async (req, res) => res.json(await risk.saveRules(req.body))));

// Mera asli record (Upstox P&L report)
router.post('/broker/sync', ah(async (req, res) => res.json(await broker.sync())));
router.get('/broker/analysis', ah(async (req, res) => res.json(await broker.analysis())));

// Upstox se apne aap: delta, slippage, charges, lot size
router.get('/auto-defaults', ah(async (req, res) => res.json(await autoDefaults.forSymbol(req.query.symbol || 'NIFTY', Math.max(1, parseInt(req.query.lots, 10) || 1)))));

// Date picks: /api/picks?date=2026-09-24&universe=index|stocks|all&strat=orb|trend
router.get('/picks', ah(async (req, res) => res.json(await picks.picks({ date: req.query.date, universe: req.query.universe, strat: req.query.strat }))));

// Paper trading tracker
const pq = (q) => ({ universe: q.universe === 'stocks' || q.universe === 'all' ? q.universe : 'index', strat: q.strat === 'trend' ? 'trend' : 'orb' });
router.get('/paper', ah(async (req, res) => res.json(await paper.summary(pq(req.query)))));
router.post('/paper/backfill', ah(async (req, res) => res.json(await paper.backfill({ ...pq(req.body), days: req.body.days }))));
router.delete('/paper', ah(async (req, res) => res.json({ deleted: await paper.clear(pq(req.query)) })));

// Asli option premium backtest (Iron Fly / ORB buy)
router.post('/option-backtest', ah(async (req, res) => res.json(await optBt.run(req.body))));

router.get('/strategy/params', (req, res) => res.json(strategy.withDefaults(pickParams(req.query))));
router.post('/backtest', ah(async (req, res) => res.status(201).json(await bt.runBacktest(req.body))));
router.get('/backtest', ah(async (req, res) => res.json(await bt.listRuns())));
router.delete('/backtest', ah(async (req, res) => res.json({ deleted: await bt.clearRuns() })));
router.get('/backtest/:id', ah(async (req, res) => res.json(await bt.getRun(req.params.id))));
router.delete('/backtest/:id', ah(async (req, res) => res.json({ deleted: (await bt.deleteRun(req.params.id))._id })));

module.exports = router;
