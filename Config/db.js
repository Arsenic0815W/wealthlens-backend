const mongoose = require('mongoose');
require('dotenv').config();

const MAX_RETRIES = Infinity; // keep trying — never crash the server
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectDB() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
      });
      console.log('Connected to MongoDB');

      // Handle disconnects after initial connection
      mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected — will retry connection...');
      });

      mongoose.connection.on('error', (err) => {
        console.error('MongoDB connection error:', err.message);
      });

      return;
    } catch (err) {
      console.error(`MongoDB connection attempt ${attempt} failed: ${err.message}`);
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

module.exports = connectDB;
