const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const config = require('./config/env');
const { apiKeyAuth } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
if (config.nodeEnv !== 'test') app.use(morgan('dev'));

app.get('/api/health', (req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', authRequired: !!config.apiKey })
);

// Webhook uses its own secret, not the API key
app.use('/api/webhook', require('./routes/webhook'));

app.use('/api', apiKeyAuth);
app.use('/api/instruments', require('./routes/instruments'));
app.use('/api/trades', require('./routes/trades'));
app.use('/api/prices', require('./routes/prices'));
app.use('/api/reports', require('./routes/reports'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(errorHandler);

module.exports = app;
