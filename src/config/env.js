require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const config = {
  port: num(process.env.PORT, 5000),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || '',
  apiKey: process.env.API_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  timezone: process.env.REPORT_TIMEZONE || 'Asia/Kolkata',
  rules: {
    tp1ExitPercent: num(process.env.TP1_EXIT_PERCENT, 50),
    moveSlToCostOnTp1: bool(process.env.MOVE_SL_TO_COST_ON_TP1, true),
    brokeragePerOrder: num(process.env.BROKERAGE_PER_ORDER, 20),
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    // Kis number pe bhejna hai (country code ke saath, + nahi). Comma se kai numbers.
    to: (process.env.WHATSAPP_TO || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
    template: process.env.WHATSAPP_TEMPLATE || 'lead_notification',
    language: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
    templateParams: num(process.env.WHATSAPP_TEMPLATE_PARAMS, 5), // template body me kitne {{n}}
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },
  dailyReportTime: process.env.DAILY_REPORT_TIME || '',
  upstox: {
    apiKey: process.env.UPSTOX_API_KEY || '',
    apiSecret: process.env.UPSTOX_API_SECRET || '',
    redirectUri: process.env.UPSTOX_REDIRECT_URI || `http://localhost:${num(process.env.PORT, 5000)}/auth/upstox/callback`,
    // Optional: Upstox "Analytics Token" (long validity, sirf market data - order nahi)
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
  },
  livePollSeconds: num(process.env.LIVE_POLL_SECONDS, 5), // open trades ka live LTP kitne second me (0 = off)
  // Paper trading: roz 15:35 pe is universe + strategy ka pehla signal record hota hai
  paper: {
    universe: process.env.PAPER_UNIVERSE || 'index', // index | stocks | all
    strat: process.env.PAPER_STRAT || 'orb', // orb | trend
  },
  // Capital protection defaults (dashboard se badal sakte ho, DB me save hota hai)
  risk: {
    capital: num(process.env.CAPITAL, 30000),
    riskPct: num(process.env.RISK_PCT, 1.5), // ek trade me capital ka max % loss -> lots isi se
    maxTradesPerDay: num(process.env.MAX_TRADES_PER_DAY, 2),
    dailyLossPct: num(process.env.DAILY_LOSS_PCT, 3),
    monthlyLossPct: num(process.env.MONTHLY_LOSS_PCT, 10),
    noExpiryDay: bool(process.env.NO_EXPIRY_DAY, true),
  },
  signals: {
    watchlist: (process.env.WATCHLIST || 'NIFTY,BANKNIFTY')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    intervalMin: num(process.env.SIGNAL_INTERVAL_MIN, 3),
    // Live scan ki strategy: scalp (3m momentum, time stop) | orb | trend | pdhl | vwaprev
    strategy: process.env.SIGNAL_STRATEGY || 'scalp',
    alerts: bool(process.env.SIGNAL_ALERTS, true), // naya signal aaye to WhatsApp pe
  },
};

module.exports = config;
