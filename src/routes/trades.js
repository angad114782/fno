const router = require('express').Router();
const svc = require('../services/tradeService');
const ah = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');

router.get('/', ah(async (req, res) => res.json(await svc.listTrades(req.query))));
router.post('/', ah(async (req, res) => res.status(201).json(await svc.createTrade(req.body))));
router.get('/:id', ah(async (req, res) => res.json(await svc.findTrade(req.params.id))));
router.patch('/:id', ah(async (req, res) => res.json(await svc.updateTrade(req.params.id, req.body))));
router.delete('/:id', ah(async (req, res) => res.json({ deleted: (await svc.deleteTrade(req.params.id))._id })));

// Manual exit (full ya partial): { price, quantity? }
router.post(
  '/:id/exit',
  ah(async (req, res) => {
    const { price, quantity, time } = req.body;
    res.json(await svc.exitTrade(req.params.id, { price, quantity, time, reason: 'MANUAL' }));
  })
);

router.post('/:id/cancel', ah(async (req, res) => res.json(await svc.cancelTrade(req.params.id))));

// LTP update -> auto SL/TP1/TP2 check: { ltp }
router.post(
  '/:id/price',
  ah(async (req, res) => {
    if (req.body.ltp === undefined) throw new HttpError(400, 'ltp is required');
    res.json(await svc.priceUpdateById(req.params.id, req.body.ltp));
  })
);

module.exports = router;
