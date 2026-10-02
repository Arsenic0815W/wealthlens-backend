const yahooFinance = require('../utils/yahooFinance');
const Holding = require('../models/Holding');
const { PRICE_SYNCABLE_TYPES, isPriceSyncable } = require('../models/Holding');
const { normalizeTicker } = require('./priceSync');

const DAY_MS = 86400000;
const CACHE_TTL_MS = 15 * 60 * 1000;

// pönytail: per-process cache, lost on restart and unbounded by symbol count —
// upgrade path: LRU cap, or persist daily closes in a Mongo collection.
const closesCache = new Map(); // symbol -> { fetchedAt, from, closes: [[YYYY-MM-DD, close], ...] }

async function getDailyCloses(symbol, from) {
  const hit = closesCache.get(symbol);
  if (hit && hit.from <= from && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.closes;

  const result = await yahooFinance.chart(symbol, {
    period1: from,
    period2: new Date(),
    interval: '1d',
  });
  const closes = (result?.quotes || [])
    .filter((q) => q.close != null)
    .map((q) => [new Date(q.date).toISOString().slice(0, 10), q.close]);

  closesCache.set(symbol, { fetchedAt: Date.now(), from, closes });
  return closes;
}

/**
 * Pure part of the history calculation, kept separate so it can be checked
 * without network access.
 *
 * Each holding's value on a date is its most recent close on or before that
 * date (forward-fill). Without this, a date on which only some assets traded
 * (e.g. Saturday: crypto yes, NSE no) would sum only those assets and the
 * chart would dip every weekend and holiday.
 *
 * items: [{ symbol, quantity, buyKey: 'YYYY-MM-DD' }]
 * closesBySymbol: Map(symbol -> [[dateKey, close], ...] sorted by date)
 */
function buildHistorySeries(items, closesBySymbol) {
  const dates = new Set();
  for (const item of items) {
    for (const [date] of closesBySymbol.get(item.symbol) || []) {
      if (date >= item.buyKey) dates.add(date);
    }
  }

  const cursors = items.map(() => ({ i: 0, last: null }));

  return [...dates].sort().map((date) => {
    let value = 0;
    items.forEach((item, k) => {
      if (date < item.buyKey) return;
      const closes = closesBySymbol.get(item.symbol) || [];
      const cursor = cursors[k];
      while (cursor.i < closes.length && closes[cursor.i][0] <= date) {
        cursor.last = closes[cursor.i][1];
        cursor.i++;
      }
      if (cursor.last != null) value += item.quantity * cursor.last;
    });
    return { date, value: Math.round(value) };
  });
}

// Recomputed from Yahoo's historical data (cached briefly) — no stored snapshots.
async function getPortfolioHistory(userId) {
  const holdings = (
    await Holding.find({ user: userId, assetType: { $in: PRICE_SYNCABLE_TYPES } })
  ).filter((h) => isPriceSyncable(h.ticker, h.assetType));
  if (holdings.length === 0) return [];

  const items = holdings.map((h) => ({
    symbol: normalizeTicker(h.ticker, h.assetType),
    quantity: Number(h.quantity),
    buyDate: new Date(h.buyDate),
    buyKey: new Date(h.buyDate).toISOString().slice(0, 10),
  }));

  // One fetch per unique symbol, starting a week before its earliest buy so a
  // weekend/holiday buy date still has a prior close to forward-fill from.
  const fromBySymbol = new Map();
  for (const item of items) {
    const from = new Date(item.buyDate.getTime() - 7 * DAY_MS);
    const current = fromBySymbol.get(item.symbol);
    if (!current || from < current) fromBySymbol.set(item.symbol, from);
  }

  // pönytail: fires all symbol requests at once — fine for a personal
  // portfolio, upgrade path: limit concurrency if Yahoo starts rate-limiting.
  const closesBySymbol = new Map();
  await Promise.all(
    [...fromBySymbol].map(async ([symbol, from]) => {
      try {
        closesBySymbol.set(symbol, await getDailyCloses(symbol, from));
      } catch (err) {
        // skip this symbol if its data can't be fetched — don't fail the whole chart
        console.error(`History fetch failed for ${symbol}:`, err.message);
      }
    })
  );

  const available = items.filter((item) => closesBySymbol.get(item.symbol)?.length);
  return buildHistorySeries(available, closesBySymbol);
}

module.exports = { getPortfolioHistory, buildHistorySeries };
