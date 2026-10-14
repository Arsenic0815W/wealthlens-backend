const Holding = require('../models/Holding');

const ASSET_TYPE_LABELS = {
  STOCK: 'Stocks',
  MUTUAL_FUND: 'Mutual Funds',
  BOND: 'Bonds',
  ETF: 'ETFs',
  GOLD: 'Gold',
  CRYPTO: 'Crypto',
  OTHER: 'Other',
};

// Uses synced price if available, else falls back to buy price so unsynced assets still count.
function currentValueOf(holding) {
  const price =
    holding.currentPrice != null ? Number(holding.currentPrice) : Number(holding.buyPrice);
  return Number(holding.quantity) * price;
}

async function getAllocationInsights(userId) {
  const holdings = await Holding.find({ user: userId });

  if (holdings.length === 0) {
    return {
      totalValue: 0,
      byAssetType: [],
      byHolding: [],
      insights: ["You haven't added any holdings yet — add one to see your portfolio breakdown."],
    };
  }

  const totalValue = holdings.reduce((sum, h) => sum + currentValueOf(h), 0);

  const assetTypeMap = {};
  for (const h of holdings) {
    const value = currentValueOf(h);
    if (!assetTypeMap[h.assetType]) assetTypeMap[h.assetType] = 0;
    assetTypeMap[h.assetType] += value;
  }
  const byAssetType = Object.entries(assetTypeMap)
    .map(([assetType, value]) => ({
      assetType,
      label: ASSET_TYPE_LABELS[assetType] || assetType,
      value,
      percent: totalValue > 0 ? (value / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // Several buys of the same asset are one position for concentration purposes.
  const positionMap = {};
  for (const h of holdings) {
    const key = `${h.ticker}|${h.assetType}`;
    positionMap[key] ||= { id: h._id, ticker: h.ticker, assetType: h.assetType, value: 0 };
    positionMap[key].value += currentValueOf(h);
  }
  const byHolding = Object.values(positionMap)
    .map((p) => ({ ...p, percent: totalValue > 0 ? (p.value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);

  const insights = [];

  const topHolding = byHolding[0];
  if (topHolding && topHolding.percent >= 25) {
    insights.push(
      `${topHolding.ticker} makes up ${topHolding.percent.toFixed(0)}% of your portfolio — that's a large share in one position, so its ups and downs will have an outsized effect on your overall returns.`
    );
  }

  const topAssetType = byAssetType[0];
  if (topAssetType && topAssetType.percent >= 70 && byAssetType.length > 1) {
    insights.push(
      `${topAssetType.percent.toFixed(0)}% of your portfolio is in ${topAssetType.label.toLowerCase()} — you may want to consider spreading investments across other asset types too, depending on your goals.`
    );
  } else if (byAssetType.length === 1) {
    insights.push(
      `Your entire portfolio is currently in ${topAssetType.label.toLowerCase()} — that's fine if it's intentional, but you have no exposure to other asset classes right now.`
    );
  }

  if (
    topHolding &&
    topHolding.percent < 25 &&
    (!topAssetType || topAssetType.percent < 70) &&
    byAssetType.length > 1
  ) {
    insights.push(
      `Your portfolio is reasonably spread out — no single holding or asset type dominates the total.`
    );
  }

  if (byHolding.length <= 2) {
    insights.push(
      `You only have ${byHolding.length} position${byHolding.length === 1 ? '' : 's'} tracked so far — insights will get more useful as you add more.`
    );
  }

  return { totalValue, byAssetType, byHolding, insights };
}

module.exports = { getAllocationInsights };
