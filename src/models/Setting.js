const mongoose = require('mongoose');

// Simple key/value store (e.g. Upstox access token)
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    expiresAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
