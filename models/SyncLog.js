const mongoose = require('mongoose');

// Tracks the last date the daily sync ran (IST, YYYY-MM-DD) so the server
// can detect a missed sync on startup and catch up immediately.
const syncLogSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  lastRunDate: { type: String, required: true },
});

module.exports = mongoose.model('SyncLog', syncLogSchema);
