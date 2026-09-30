const mongoose = require('mongoose');

const exitSchema = new mongoose.Schema(
  {
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    reason: { type: String, enum: ['TP1', 'TP2', 'SL', 'TRAIL_SL', 'MANUAL', 'EOD'], required: true },
    time: { type: Date, default: Date.now },
    pnl: { type: Number, default: 0 },
  },
  { _id: true }
);

const tradeSchema = new mongoose.Schema(
  {
    // Contract
    underlying: { type: String, required: true, uppercase: true, trim: true, index: true },
    instrumentType: { type: String, enum: ['INDEX', 'STOCK'], required: true },
    exchange: { type: String, enum: ['NSE', 'BSE'], default: 'NSE' },
    segment: { type: String, enum: ['FUT', 'OPT'], required: true },
    optionType: { type: String, enum: ['CE', 'PE', null], default: null },
    strike: { type: Number, default: null },
    expiry: { type: Date, required: true },
    tradingSymbol: { type: String, index: true },
    instrumentKey: { type: String, default: null }, // Upstox key (live LTP ke liye)

    // Position
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    lotSize: { type: Number, required: true, min: 1 },
    lots: { type: Number, required: true, min: 1 },
    quantity: { type: Number, required: true, min: 1 },
    openQuantity: { type: Number, required: true, min: 0 },

    // Levels
    entryPrice: { type: Number, required: true, min: 0 },
    entryTime: { type: Date, default: Date.now, index: true },
    stopLoss: { type: Number, default: null },
    initialStopLoss: { type: Number, default: null },
    target1: { type: Number, default: null },
    target2: { type: Number, default: null },

    // Level status
    tp1Hit: { type: Boolean, default: false },
    tp1HitAt: Date,
    tp2Hit: { type: Boolean, default: false },
    tp2HitAt: Date,
    slHit: { type: Boolean, default: false },
    slHitAt: Date,

    exits: { type: [exitSchema], default: [] },
    exitTime: { type: Date, index: true },
    avgExitPrice: { type: Number, default: null },

    lastPrice: { type: Number, default: null },
    lastPriceAt: Date,

    status: {
      type: String,
      enum: ['OPEN', 'PARTIAL', 'CLOSED', 'CANCELLED'],
      default: 'OPEN',
      index: true,
    },
    result: { type: String, enum: ['WIN', 'LOSS', 'BREAKEVEN', null], default: null },

    // P&L
    grossPnl: { type: Number, default: 0 },
    extraCharges: { type: Number, default: 0 }, // STT/GST/stamp etc. manually
    charges: { type: Number, default: 0 },
    netPnl: { type: Number, default: 0 },
    riskPerUnit: { type: Number, default: null },
    rrTp1: { type: Number, default: null },
    rrTp2: { type: Number, default: null },
    rMultiple: { type: Number, default: null },

    // Meta
    strategy: { type: String, trim: true },
    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    source: { type: String, enum: ['MANUAL', 'WEBHOOK', 'SIGNAL'], default: 'MANUAL' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Trade', tradeSchema);
