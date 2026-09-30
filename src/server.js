const config = require('./config/env');
const connectDB = require('./config/db');
const app = require('./app');
const { seedInstruments } = require('./seed');
const { startScheduler } = require('./services/scheduler');
const { startLive } = require('./services/liveService');
const { startPaperScheduler } = require('./services/paperService');

(async () => {
  try {
    await connectDB();
    const added = await seedInstruments();
    if (added) console.log(`Seeded ${added} default indices`);
    startScheduler();
    startLive();
    startPaperScheduler({ universe: config.paper.universe, strat: config.paper.strat });
    app.listen(config.port, () => {
      console.log(`F&O Trade Reporter running on http://localhost:${config.port}`);
      if (!config.apiKey) console.warn('WARNING: API_KEY not set - API is open to anyone who can reach it');
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
