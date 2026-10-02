const cron = require('node-cron');
const SyncLog = require('../models/SyncLog');
const { syncAllPrices } = require('./priceSync');
const { syncMutualFundPrices } = require('./mfNavSync');
const { getMarketStatus } = require('./marketStatus');
const { toISTDateString } = require('../utils/dates');

const SYNC_KEY = 'dailyPriceSync';

/**
 * Syncs market prices and mutual fund NAVs together.
 * With no userId it's the global daily sync and records today's run in
 * SyncLog; with a userId it only touches that user's holdings (manual button)
 * and leaves SyncLog alone, so it can't suppress the global catch-up.
 */
async function runFullSync({ userId } = {}) {
  const filter = userId ? { user: userId } : {};
  const [market, mutualFunds] = await Promise.all([
    syncAllPrices(filter),
    syncMutualFundPrices(filter),
  ]);
  console.log(`Market sync: ${market.updated} updated, ${market.failed} failed.`);
  console.log(`Mutual fund sync: ${mutualFunds.updated} updated, ${mutualFunds.failed} failed.`);

  if (!userId) {
    await SyncLog.findOneAndUpdate(
      { key: SYNC_KEY },
      { lastRunDate: toISTDateString() },
      { upsert: true }
    );
  }

  return { market, mutualFunds };
}

// Guarantees at least one global sync per trading day, whenever the server is
// next started that day (the 4 PM cron below covers a continuously running server).
async function checkAndRunCatchUpSync() {
  const status = getMarketStatus();
  if (!status.isOpen) {
    console.log(
      `Market closed today (${status.reason === 'holiday' ? status.holidayName : 'weekend'}) — skipping sync.`
    );
    return;
  }

  const log = await SyncLog.findOne({ key: SYNC_KEY });
  if (log && log.lastRunDate === toISTDateString()) {
    console.log("Today's price sync already ran — nothing to do.");
    return;
  }

  console.log('No sync recorded yet today — running it now...');
  await runFullSync();
}

function scheduleDailySync() {
  cron.schedule(
    '0 16 * * 1-5',
    async () => {
      // node-cron doesn't catch async errors — an escaped rejection here
      // would be unhandled and can take the process down.
      try {
        const status = getMarketStatus();
        if (!status.isOpen) {
          console.log(
            `Market closed today (${status.holidayName || 'weekend'}) — skipping scheduled sync.`
          );
          return;
        }
        console.log('Running scheduled daily price sync...');
        await runFullSync();
      } catch (err) {
        console.error('Scheduled price sync failed:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
  console.log(
    'Daily price sync scheduled for 4:00 PM IST on trading days (plus startup catch-up if missed).'
  );
}

module.exports = { runFullSync, checkAndRunCatchUpSync, scheduleDailySync };
