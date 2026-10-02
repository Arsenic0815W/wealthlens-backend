const { getAllocationInsights } = require('../services/allocationInsights');
const { evaluatePurchase } = require('../services/purchaseEvaluator');
const { getPortfolioHistory } = require('../services/portfolioHistory');
const Holding = require('../models/Holding');
const { isPriceSyncable } = require('../models/Holding');
const asyncHandler = require('../utils/asyncHandler');

exports.getAllocation = asyncHandler(async (req, res) => {
  const insights = await getAllocationInsights(req.user._id);
  res.json(insights);
});

// Evaluates whether a specific holding's buy price was a good entry point.
exports.evaluateHolding = asyncHandler(async (req, res) => {
  const holding = await Holding.findOne({ _id: req.params.id, user: req.user._id });

  if (!holding) {
    return res.status(404).json({ error: 'Holding not found' });
  }

  if (!isPriceSyncable(holding.ticker, holding.assetType)) {
    return res.status(400).json({
      error: `Purchase evaluation needs market price history, which ${holding.ticker} doesn't have — it's available for Stocks, ETFs, exchange-traded Gold, and Crypto.`,
    });
  }

  const result = await evaluatePurchase({
    ticker: holding.ticker,
    assetType: holding.assetType,
    buyPrice: Number(holding.buyPrice),
    buyDate: holding.buyDate,
    currentPrice: holding.currentPrice,
  });

  res.json(result);
});

exports.getPortfolioHistoryHandler = asyncHandler(async (req, res) => {
  const history = await getPortfolioHistory(req.user._id);
  res.json(history);
});
