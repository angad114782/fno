const mongoose = require('mongoose');

const instrumentSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, trim: true },
    type: { type: String, enum: ['INDEX', 'STOCK'], required: true },
    exchange: { type: String, enum: ['NSE', 'BSE'], default: 'NSE' },
    lotSize: { type: Number, required: true, min: 1 },
    strikeStep: { type: Number, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Instrument', instrumentSchema);
