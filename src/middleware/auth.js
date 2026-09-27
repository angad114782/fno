const crypto = require('crypto');
const config = require('../config/env');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// API_KEY set ho to header "x-api-key" (ya ?key=) required.
function apiKeyAuth(req, res, next) {
  if (!config.apiKey) return next();
  const key = req.get('x-api-key') || req.query.key;
  if (key && safeEqual(key, config.apiKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key' });
}

module.exports = { apiKeyAuth, safeEqual };
