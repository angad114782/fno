const router = require('express').Router();
const Instrument = require('../models/Instrument');
const ah = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');

const pick = (b) => {
  const out = {};
  for (const k of ['symbol', 'name', 'type', 'exchange', 'lotSize', 'strikeStep', 'active']) if (k in b) out[k] = b[k];
  return out;
};

router.get(
  '/',
  ah(async (req, res) => {
    const filter = {};
    if (req.query.type) filter.type = String(req.query.type).toUpperCase();
    if (req.query.active !== 'all') filter.active = true;
    res.json(await Instrument.find(filter).sort({ type: 1, symbol: 1 }));
  })
);

router.post(
  '/',
  ah(async (req, res) => {
    res.status(201).json(await Instrument.create(pick(req.body)));
  })
);

router.patch(
  '/:symbol',
  ah(async (req, res) => {
    const inst = await Instrument.findOneAndUpdate({ symbol: req.params.symbol.toUpperCase() }, pick(req.body), {
      new: true,
      runValidators: true,
    });
    if (!inst) throw new HttpError(404, 'Instrument not found');
    res.json(inst);
  })
);

router.delete(
  '/:symbol',
  ah(async (req, res) => {
    const inst = await Instrument.findOneAndDelete({ symbol: req.params.symbol.toUpperCase() });
    if (!inst) throw new HttpError(404, 'Instrument not found');
    res.json({ deleted: inst.symbol });
  })
);

module.exports = router;
