const mongoose = require('mongoose');

// Paper trade: roz ka "⭐ pehla signal" (bina paisa). Ek din + universe + strategy = ek record.
const paperTradeSchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    universe: { type: String, required: true },
    strat: { type: String, required: true },
    noTrade: { type: Boolean, default: false },
    reason: String,
    symbol: String,
    signal: String, // BUY CE | BUY PE
    option: String,
    time: String,
    entry: Number,
    stopLoss: Number,
    target1: Number,
    target2: Number,
    lotSize: Number,
    result: mongoose.Schema.Types.Mixed, // { code, text, time, reasons }
    flags: mongoose.Schema.Types.Mixed, // entry ke waqt 3 flags
    points: Number,
    grossPnl: Number, // option ka andaza (delta 0.5), 1 lot
    charges: Number,
    netPnl: Number,
  },
  { timestamps: true }
);
paperTradeSchema.index({ day: 1, universe: 1, strat: 1 }, { unique: true });

module.exports = mongoose.model('PaperTrade', paperTradeSchema);
