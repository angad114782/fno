// Browser OAuth flow: /auth/upstox/login -> Upstox login -> /auth/upstox/callback
const crypto = require('crypto');
const router = require('express').Router();
const upstox = require('../services/upstox');
const ah = require('../utils/asyncHandler');

const states = new Map(); // state -> createdAt (CSRF check)

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:15px system-ui;padding:32px;max-width:560px;margin:auto"><h2>${title}</h2><p>${body}</p><p><a href="/">Dashboard pe wapas jao</a></p></body>`;

router.get('/login', (req, res) => {
  const state = crypto.randomBytes(12).toString('hex');
  states.set(state, Date.now());
  for (const [k, t] of states) if (Date.now() - t > 10 * 60000) states.delete(k);
  try {
    res.redirect(upstox.loginUrl(state));
  } catch (err) {
    res.status(400).send(page('Upstox setup pending', err.message));
  }
});

router.get(
  '/callback',
  ah(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(page('Upstox login cancel/fail', String(error)));
    if (!state || !states.has(state)) return res.status(400).send(page('Invalid login', 'Login link purana hai, dashboard se dobara try karo'));
    states.delete(state);
    if (!code) return res.status(400).send(page('Invalid login', 'code missing'));
    try {
      const t = await upstox.exchangeCode(String(code));
      res.send(page('✅ Upstox connected', `User: ${t.user || '-'}<br>Token valid till: ${t.expiresAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`));
    } catch (err) {
      res.status(400).send(page('Upstox login failed', err.message));
    }
  })
);

module.exports = router;
