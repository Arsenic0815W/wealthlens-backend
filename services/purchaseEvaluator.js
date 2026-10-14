const yahooFinance = require('../utils/yahooFinance');
const { normalizeTicker } = require('./priceSync');

const DAY_MS = 86400000;

/**
 * Evaluates whether a buy price was a good entry point, using only free,
 * no-API-key data from Yahoo Finance:
 *   - 52-week high/low positioning over the year before the buy date
 *   - 50-day / 200-day moving average positioning at buy time
 *   - current unrealized gain/loss
 *
 * Rule-based, not ML — every number is traceable to a specific signal,
 * which is the whole point: explainable, not a black box.
 *
 * Only works for PRICE_SYNCABLE_TYPES (Stock/ETF/Gold/Crypto) — the same
 * asset types the daily price sync covers, since both need historical data.
 */
async function evaluatePurchase({ ticker, assetType, buyPrice, buyDate, currentPrice }) {
  const symbol = normalizeTicker(ticker, assetType);
  const buyDateObj = new Date(buyDate);
  // buyDate is stored as midnight UTC, but NSE daily bars are stamped later
  // that morning — so "on or before the buy date" means before the next day.
  const buyDayEnd = new Date(buyDateObj.getTime() + DAY_MS);

  // Every signal here is measured AS OF the buy date, so the lookback is
  // anchored there, not today. 400 calendar days ≈ 270 NSE sessions after
  // weekends and holidays: enough for the 52-week window and the 200-day MA.
  const period1 = new Date(buyDateObj.getTime() - 400 * DAY_MS);
  const period2 = new Date();

  const result = await yahooFinance.chart(symbol, { period1, period2, interval: '1d' });
  const quotes = (result?.quotes || []).filter((q) => q.close != null);

  if (quotes.length === 0) {
    throw new Error(`No historical data available for ${ticker}`);
  }

  const quotesBeforeBuy = quotes.filter((q) => new Date(q.date) < buyDayEnd);

  const yearBeforeBuyStart = new Date(buyDateObj.getTime() - 365 * DAY_MS);
  const yearBeforeBuy = quotesBeforeBuy.filter((q) => new Date(q.date) >= yearBeforeBuyStart);
  const week52High =
    yearBeforeBuy.length > 0 ? Math.max(...yearBeforeBuy.map((q) => q.close)) : null;
  const week52Low =
    yearBeforeBuy.length > 0 ? Math.min(...yearBeforeBuy.map((q) => q.close)) : null;

  // Moving averages AT THE TIME OF PURCHASE (not today)
  const ma50AtBuy = simpleMovingAverage(quotesBeforeBuy, 50);
  const ma200AtBuy = simpleMovingAverage(quotesBeforeBuy, 200);

  const vsMa50Pct = ma50AtBuy ? ((buyPrice - ma50AtBuy) / ma50AtBuy) * 100 : null;
  const vsMa200Pct = ma200AtBuy ? ((buyPrice - ma200AtBuy) / ma200AtBuy) * 100 : null;

  const hasRange = week52High != null && week52Low != null && week52High !== week52Low;
  const rangePosition = hasRange
    ? Math.min(Math.max((buyPrice - week52Low) / (week52High - week52Low), 0), 1)
    : null;

  const price = currentPrice != null ? Number(currentPrice) : null;
  const unrealizedPnlPct = price != null ? ((price - buyPrice) / buyPrice) * 100 : null;

  // Weighted rule-based score from -100 to +100
  let score = 0;
  const reasons = [];

  if (rangePosition == null) {
    reasons.push(
      `There isn't enough price history before your buy date to place it within ${ticker}'s 52-week range.`
    );
  } else {
    score += (0.5 - rangePosition) * 100 * 0.4;
    if (rangePosition < 0.35) {
      reasons.push(
        `You bought near the lower end of ${ticker}'s 52-week range at the time — that's typically a favorable entry point.`
      );
    } else if (rangePosition > 0.65) {
      reasons.push(
        `You bought near the upper end of ${ticker}'s 52-week range at the time — a riskier time to enter, since the price had already run up.`
      );
    } else {
      reasons.push(
        `Your buy price was roughly in the middle of ${ticker}'s 52-week range at the time — neither particularly cheap nor expensive.`
      );
    }
  }

  if (vsMa50Pct !== null) {
    score += -vsMa50Pct * 0.3;
    reasons.push(
      vsMa50Pct < -3
        ? `You bought ${Math.abs(vsMa50Pct).toFixed(1)}% below the 50-day average price at the time — a sign of buying on a dip.`
        : vsMa50Pct > 3
          ? `You bought ${vsMa50Pct.toFixed(1)}% above the 50-day average at the time — you paid a premium over the recent trend.`
          : `Your buy price was close to the 50-day average at the time.`
    );
  }

  if (vsMa200Pct !== null) {
    score += -vsMa200Pct * 0.3;
    reasons.push(
      vsMa200Pct < -3
        ? `You also bought ${Math.abs(vsMa200Pct).toFixed(1)}% below the longer-term 200-day average — reinforces that this was a dip entry.`
        : vsMa200Pct > 3
          ? `You bought ${vsMa200Pct.toFixed(1)}% above the 200-day average — above the longer-term trend line.`
          : `Your buy price was close to the 200-day average as well.`
    );
  }

  score = Math.min(Math.max(score, -100), 100);
  // With no signal at all the score is a meaningless 0 — give no verdict rather than "Fair".
  const noSignals = rangePosition == null && vsMa50Pct == null && vsMa200Pct == null;
  const verdict = noSignals
    ? null
    : score >= 20 ? 'Good Entry' : score <= -20 ? 'Overpaid' : 'Fair Entry';

  const nextSteps = generateNextSteps({ verdict, unrealizedPnlPct, vsMa200Pct });

  const sinceBuy = quotes.filter((q) => new Date(q.date) >= buyDateObj);
  const historySinceBuy = sinceBuy.length > 0 ? sinceBuy : quotes;
  const priceHistory = downsample(
    historySinceBuy.map((q) => ({ date: q.date, close: Math.round(q.close * 100) / 100 })),
    120
  );

  return {
    ticker,
    buyPrice,
    currentPrice: price,
    unrealizedPnlPct: unrealizedPnlPct != null ? Math.round(unrealizedPnlPct * 100) / 100 : null,
    verdict,
    score: Math.round(score * 100) / 100,
    signals: {
      week52High: week52High != null ? Math.round(week52High * 100) / 100 : null,
      week52Low: week52Low != null ? Math.round(week52Low * 100) / 100 : null,
      rangePositionPct: rangePosition != null ? Math.round(rangePosition * 100 * 100) / 100 : null,
      ma50AtBuy: ma50AtBuy != null ? Math.round(ma50AtBuy * 100) / 100 : null,
      ma200AtBuy: ma200AtBuy != null ? Math.round(ma200AtBuy * 100) / 100 : null,
    },
    reasons,
    nextSteps,
    priceHistory,
    evaluatedAt: new Date(),
  };
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const result = points.filter((_, i) => i % step === 0);
  if (result[result.length - 1] !== points[points.length - 1]) {
    result.push(points[points.length - 1]);
  }
  return result;
}

function generateNextSteps({ verdict, unrealizedPnlPct, vsMa200Pct }) {
  const steps = [];

  if (unrealizedPnlPct != null) {
    if (unrealizedPnlPct <= -15) {
      steps.push(
        'This position is down 15%+ from your buy price. Worth revisiting whether the original reason you bought it still holds.'
      );
    } else if (unrealizedPnlPct >= 25) {
      steps.push(
        'This position is up 25%+ since you bought it. Some investors consider booking partial profits at gains like this, though that depends on your goals.'
      );
    }
  }

  if (verdict === 'Overpaid' && vsMa200Pct !== null && vsMa200Pct > 10) {
    steps.push(
      "Your entry was well above the long-term trend — if you're considering adding more, it may be worth waiting for a better price rather than averaging up here."
    );
  }

  if (verdict === 'Good Entry') {
    steps.push(
      'This looks like it was a well-timed entry. If you still believe in this position, it could be a reasonable candidate to add to on future dips.'
    );
  }

  if (steps.length === 0) {
    steps.push(
      'No strong signal either way for this position right now — just keep an eye on it as you would any holding.'
    );
  }

  return steps;
}

function simpleMovingAverage(sortedQuotes, period) {
  if (sortedQuotes.length < period) return null;
  const lastN = sortedQuotes.slice(-period);
  const sum = lastN.reduce((acc, q) => acc + q.close, 0);
  return sum / period;
}

module.exports = { evaluatePurchase };
