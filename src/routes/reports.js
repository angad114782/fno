const router = require('express').Router();
const svc = require('../services/reportService');
const notifier = require('../services/notifier');
const ah = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');

// Query filters: from, to (YYYY-MM-DD), underlying, segment, side, optionType, strategy, tag
router.get('/', ah(async (req, res) => res.json(await svc.fullReport(req.query))));
router.get('/summary', ah(async (req, res) => res.json((await svc.fullReport(req.query)).summary)));
router.get('/daily', ah(async (req, res) => res.json((await svc.fullReport(req.query)).daily)));
router.get('/monthly', ah(async (req, res) => res.json((await svc.fullReport(req.query)).monthly)));
router.get('/by-underlying', ah(async (req, res) => res.json((await svc.fullReport(req.query)).byUnderlying)));
router.get('/by-strategy', ah(async (req, res) => res.json((await svc.fullReport(req.query)).byStrategy)));
router.get('/day', ah(async (req, res) => res.json(await svc.dayReport(req.query.date))));

router.get(
  '/export.csv',
  ah(async (req, res) => {
    const csv = await svc.exportCsv(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fno-trades-${Date.now()}.csv"`);
    res.send(csv);
  })
);

router.post(
  '/telegram',
  ah(async (req, res) => {
    if (!notifier.enabled()) throw new HttpError(400, 'Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
    res.json({ sent: await svc.sendDayReport(req.body.date) });
  })
);

module.exports = router;
