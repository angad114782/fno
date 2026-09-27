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
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  dailyReportTime: process.env.DAILY_REPORT_TIME || '',
};

module.exports = config;
