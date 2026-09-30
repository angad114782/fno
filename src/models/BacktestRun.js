const mongoose = require('mongoose');

const backtestRunSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    interval: Number,
    from: String,
    to: String,
    mode: String,
    params: mongoose.Schema.Types.Mixed,
    options: mongoose.Schema.Types.Mixed,
    candles: Number,
    signalsSeen: Number,
    skipped: mongoose.Schema.Types.Mixed,
    sessions: mongoose.Schema.Types.Mixed,
    paused: Number,
    pausedNet: Number,
    pauseState: mongoose.Schema.Types.Mixed,
    capital: mongoose.Schema.Types.Mixed, // capital rules jo backtest me lage
    auto: mongoose.Schema.Types.Mixed, // Upstox se liye gaye delta/slippage/charges
    summary: mongoose.Schema.Types.Mixed,
    monthly: mongoose.Schema.Types.Mixed,
    daily: mongoose.Schema.Types.Mixed,
    bySide: mongoose.Schema.Types.Mixed,
    equityCurve: mongoose.Schema.Types.Mixed,
    trades: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

module.exports = mongoose.model('BacktestRun', backtestRunSchema);
