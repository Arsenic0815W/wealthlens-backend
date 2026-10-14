const yahooFinance = require('../utils/yahooFinance');
const Holding = require('../models/Holding');
const { PRICE_SYNCABLE_TYPES, isPriceSyncable } = require('../models/Holding');

// Crypto tickers are stored as plain symbols (BTC, ETH) but yahoo-finance2
// needs them as trading pairs. Everything else in the app (buyPrice, totals,
// allocation) is in rupees, so always quote crypto against INR — including a
// ticker someone typed as "BTC-USD".
function normalizeTicker(ticker, assetType) {
  if (assetType === 'CRYPTO') {
    return `${ticker.split('-')[0]}-INR`;
  }
  return ticker;
}

// Returns null on failure so one bad ticker doesn't crash a batch sync.
async function fetchPrice(ticker, assetType) {
  try {
    const symbol = normalizeTicker(ticker, assetType);
    const quote = await yahooFinance.quote(symbol);
    return quote?.regularMarketPrice ?? null;
  } catch (err) {
    console.error(`Price fetch failed for ${ticker} (${assetType}):`, err.message);
    return null;
  }
}

// Fetches each unique ticker only once, even if multiple users hold it.
// `filter` narrows the run (e.g. { user: id } for a user-triggered sync).
async function syncAllPrices(filter = {}) {
  const holdings = (
    // filter last so it can narrow assetType (e.g. CRYPTO-only on market holidays)
    await Holding.find({ assetType: { $in: PRICE_SYNCABLE_TYPES }, ...filter })
  ).filter((h) => isPriceSyncable(h.ticker, h.assetType));

  if (holdings.length === 0) {
    console.log('No syncable holdings found.');
    return { updated: 0, failed: 0 };
  }

  const uniquePairs = new Map();
  for (const h of holdings) {
    const key = `${h.ticker}|${h.assetType}`;
    if (!uniquePairs.has(key)) uniquePairs.set(key, null);
  }

  console.log(`Fetching prices for ${uniquePairs.size} unique tickers...`);

  for (const key of uniquePairs.keys()) {
    const [ticker, assetType] = key.split('|');
    const price = await fetchPrice(ticker, assetType);
    uniquePairs.set(key, price);
  }

  let updated = 0;
  let failed = 0;
  const now = new Date();

  for (const h of holdings) {
    const key = `${h.ticker}|${h.assetType}`;
    const price = uniquePairs.get(key);

    if (price === null) {
      failed++;
      continue;
    }

    h.currentPrice = price;
    h.priceUpdatedAt = now;

    // Each save is isolated so one failure doesn't abort the batch.
    try {
      await h.save();
      updated++;
    } catch (err) {
      failed++;
      console.error(`Price update failed for holding ${h._id}:`, err.message);
    }
  }

  console.log(`Price sync complete: ${updated} updated, ${failed} failed.`);
  return { updated, failed };
}

// Validates buy price against historical closing price (±10% tolerance).
// Fails open — never blocks a user over a data gap.
const PRICE_DEVIATION_TOLERANCE_PCT = 10;

async function validateBuyPrice(ticker, assetType, buyPrice, buyDate) {
  if (!isPriceSyncable(ticker, assetType)) {
    return { valid: true };
  }

  try {
    const symbol = normalizeTicker(ticker, assetType);
    const target = new Date(buyDate);

    const period1 = new Date(target);
    period1.setDate(period1.getDate() - 4);
    let period2 = new Date(target);
    period2.setDate(period2.getDate() + 4);

    const today = new Date();
    if (period2 > today) period2 = today;
    if (period1 > today) return { valid: true };

    const result = await yahooFinance.chart(symbol, { period1, period2, interval: '1d' });
    const quotes = (result?.quotes || []).filter((q) => q.close != null);

    if (quotes.length === 0) {
      return { valid: true };
    }

    let closest = quotes[0];
    let minDiff = Math.abs(new Date(closest.date) - target);
    for (const q of quotes) {
      const diff = Math.abs(new Date(q.date) - target);
      if (diff < minDiff) {
        minDiff = diff;
        closest = q;
      }
    }

    const historicalPrice = closest.close;
    const deviationPct = (Math.abs(buyPrice - historicalPrice) / historicalPrice) * 100;

    if (deviationPct > PRICE_DEVIATION_TOLERANCE_PCT) {
      return {
        valid: false,
        historicalPrice,
        deviationPct,
        message: `The price you entered (₹${buyPrice}) looks off from ${ticker}'s actual trading price around ${target.toDateString()} — it was trading near ₹${historicalPrice.toFixed(2)} then. Please double-check the buy price.`,
      };
    }

    return { valid: true, historicalPrice };
  } catch (err) {
    console.error(`Buy price validation skipped for ${ticker}:`, err.message);
    return { valid: true };
  }
}

module.exports = { fetchPrice, syncAllPrices, normalizeTicker, validateBuyPrice };
