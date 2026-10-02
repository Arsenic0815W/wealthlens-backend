require('dotenv').config();
const express = require('express');
const cors = require('cors');
// Paths match the on-disk (and git-tracked) casing exactly: Linux hosts are
// case-sensitive, so './config/db' or './routes/authRoutes' would crash there.
const connectDB = require('./Config/db');
const { checkAndRunCatchUpSync, scheduleDailySync } = require('./services/dailySync');

const app = express();

// FRONTEND_URL: comma-separated allowed origins, no trailing slash.
// Unset falls back to local Vite ports, so a missing prod value fails closed.
const origins = (process.env.FRONTEND_URL || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use(cors({ origin: origins }));
app.use(express.json());

app.use('/api/auth', require('./routes/authroutes'));
app.use('/api/holdings', require('./routes/holdingroutes'));
app.use('/api/prices', require('./routes/priceRoutes'));
app.use('/api/insights', require('./routes/insightsRoutes'));
app.use('/api/market', require('./routes/marketRoutes'));

app.get('/', (req, res) => res.json({ status: 'WealthLens API is running' }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler — must be last
app.use(require('./middleware/errorHandler'));

const PORT = process.env.PORT || 5000;

// Start the server immediately — don't wait for MongoDB
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Connect to MongoDB in the background (db.js retries until it succeeds).
// The cron is scheduled before the catch-up runs, so a failing catch-up
// can't prevent it; the .catch keeps a failure from becoming an unhandled
// rejection, which would exit Node.
connectDB()
  .then(async () => {
    scheduleDailySync();
    await checkAndRunCatchUpSync();
  })
  .catch((err) => console.error('Startup price sync failed:', err.message));
