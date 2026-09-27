// TradingView / Chartink / any alert -> JSON webhook. Body me "secret" = WEBHOOK_SECRET.
//
// New trade : { "secret":"..", "action":"BUY", "underlying":"NIFTY", "segment":"OPT", "optionType":"CE",
//               "strike":25000, "expiry":"2026-10-27", "lots":1, "entryPrice":150, "stopLoss":120,
//               "target1":190, "target2":240 }
// Price     : { "secret":"..", "action":"PRICE", "symbol":"NIFTY 27OCT26 25000 CE", "ltp":175 }
// Exit all  : { "secret":"..", "action":"EXIT",  "symbol":"NIFTY 27OCT26 25000 CE", "price":170 }
const router = require('express').Router();
const config = require('../config/env');
const Trade = require('../models/Trade');
const svc = require('../services/tradeService');
const { safeEqual } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');

const normSymbol = (s) => String(s || '').toUpperCase().trim().replace(/\s+/g, ' ');

router.post(
  '/',
  ah(async (req, res) => {
    if (!config.webhookSecret) throw new HttpError(503, 'WEBHOOK_SECRET not configured');
    const { secret, action, ...body } = req.body || {};
    if (!secret || !safeEqual(secret, config.webhookSecret)) throw new HttpError(401, 'Invalid webhook secret');

    const act = String(action || '').toUpperCase();
    if (act === 'BUY' || act === 'SELL') {
      const trade = await svc.createTrade({ ...body, side: act }, { source: 'WEBHOOK' });
      return res.status(201).json(trade);
    }
    if (act === 'PRICE') {
      return res.json({ results: await svc.priceUpdateBySymbol([{ symbol: body.symbol, ltp: body.ltp }]) });
    }
    if (act === 'EXIT') {
      const trades = await Trade.find({ tradingSymbol: normSymbol(body.symbol), status: { $in: ['OPEN', 'PARTIAL'] } });
      const results = [];
      for (const t of trades) results.push(await svc.exitTrade(t._id, { price: body.price, reason: 'MANUAL' }));
      return res.json({ closed: results.length, results });
    }
    throw new HttpError(400, 'action must be BUY, SELL, PRICE or EXIT');
  })
);

module.exports = router;
