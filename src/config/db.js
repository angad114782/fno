const mongoose = require('mongoose');
const config = require('./env');

async function connectDB() {
  if (!config.mongoUri) {
    throw new Error('MONGO_URI missing in .env');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}

module.exports = connectDB;
