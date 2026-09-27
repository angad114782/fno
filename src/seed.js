// Default indices ko DB me daalta hai (existing ko update karta hai).
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Instrument = require('./models/Instrument');
const indices = require('./config/indices');

async function seedInstruments({ overwrite = false } = {}) {
  let added = 0;
  for (const idx of indices) {
    const update = overwrite ? { $set: idx } : { $setOnInsert: idx };
    const r = await Instrument.updateOne({ symbol: idx.symbol }, update, { upsert: true });
    if (r.upsertedCount) added += 1;
  }
  return added;
}

if (require.main === module) {
  (async () => {
    await connectDB();
    const added = await seedInstruments({ overwrite: process.argv.includes('--overwrite') });
    console.log(`Seed done. ${added} new instruments added.`);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedInstruments };
