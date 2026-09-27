const router = require('express').Router();
const svc = require('../services/tradeService');
const ah = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');

// Bulk LTP feed by trading symbol:
// { "symbol": "NIFTY 27OCT26 25000 CE", "ltp": 180 }  or  [{...}, {...}]
router.post(
  '/',
  ah(async (req, res) => {
    const updates = Array.isArray(req.body) ? req.body : [req.body];
    if (!updates.every((u) => u && (u.symbol || u.tradingSymbol) && u.ltp !== undefined)) {
      throw new HttpError(400, 'Each update needs symbol and ltp');
    }
    res.json({ results: await svc.priceUpdateBySymbol(updates) });
  })
);

module.exports = router;
