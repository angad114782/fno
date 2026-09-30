// Upstox se F&O trade history (P&L report) sync + "mera asli record" analysis.
const config = require('../config/env');
const Setting = require('../models/Setting');
const upstox = require('./upstox');
const brokerStats = require('./brokerStats');
const { fyCode } = require('./riskService');

const KEY = 'broker_pnl_fo';

// Current + pichhle 2 financial years (Upstox 3 FY tak deta hai)
function lastFys(n = 3) {
  const today = upstox.istDate(new Date());
  const cur = Number(`20${fyCode(today).slice(0, 2)}`);
  return Array.from({ length: n }, (_, i) => {
    const s = cur - i;
    return `${String(s).slice(-2)}${String(s + 1).slice(-2)}`;
  });
}

async function sync() {
  const rows = [];
  const perFy = {};
  for (const fy of lastFys()) {
    const meta = await upstox.request('/v2/trade/profit-loss/metadata', { query: { segment: 'FO', financial_year: fy } });
    const count = meta?.trades_count || 0;
    perFy[fy] = count;
    const size = Math.min(meta?.page_size_limit || 5000, 5000);
    for (let page = 1; (page - 1) * size < count; page++) {
      const data = await upstox.request('/v2/trade/profit-loss/data', { query: { segment: 'FO', financial_year: fy, page_number: page, page_size: size } });
      rows.push(...(data || []).map((r) => ({ ...r, fy })));
      if (!data || data.length < size) break;
    }
  }
  await Setting.findOneAndUpdate({ key: KEY }, { value: { rows, perFy, syncedAt: new Date() } }, { upsert: true });
  return { trades: rows.length, perFy };
}

async function analysis() {
  const s = await Setting.findOne({ key: KEY });
  if (!s) return { synced: false };
  return {
    synced: true,
    syncedAt: s.value.syncedAt,
    perFy: s.value.perFy,
    ...brokerStats.analyze(s.value.rows || [], { brokeragePerOrder: config.rules.brokeragePerOrder }),
  };
}

module.exports = { sync, analysis, lastFys };
