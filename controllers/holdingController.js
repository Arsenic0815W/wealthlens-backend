const Holding = require('../models/Holding');
const { VALID_ASSET_TYPES } = require('../models/Holding');
const { validateBuyPrice } = require('../services/priceSync');
const asyncHandler = require('../utils/asyncHandler');
const { toISTDateString } = require('../utils/dates');

// Compared as IST calendar days: a "today" buyDate is stored as midnight UTC,
// which is still in the future for IST users before 5:30 AM.
const isFutureDate = (d) => {
  const t = new Date(d);
  return !isNaN(t) && toISTDateString(t) > toISTDateString();
};

// Stocks/ETFs entered by typing a raw symbol instead of picking from
// autocomplete (which already appends the right suffix) can end up
// missing the .NS exchange suffix that Yahoo Finance requires for NSE
// lookups — e.g. "CUPID" instead of "CUPID.NS". Without this, price sync
// silently fails for that holding forever. GOLD is deliberately excluded
// since it includes non-exchange entries (SGB, physical gold, etc.) that
// have no ticker suffix at all.
function normalizeTickerForStorage(ticker, assetType) {
  const upper = String(ticker).toUpperCase().trim();
  if ((assetType === 'STOCK' || assetType === 'ETF') && !upper.includes('.')) {
    return `${upper}.NS`;
  }
  return upper;
}

exports.create = asyncHandler(async (req, res) => {
  const { ticker, assetType, quantity, buyPrice, buyDate, note, confirmPrice } = req.body;

  if (
    !String(ticker ?? '').trim() ||
    !assetType ||
    !quantity ||
    buyPrice === undefined ||
    buyPrice === null ||
    buyPrice === '' ||
    !buyDate
  ) {
    return res
      .status(400)
      .json({ error: 'ticker, assetType, quantity, buyPrice, and buyDate are required' });
  }
  if (!VALID_ASSET_TYPES.includes(assetType)) {
    return res
      .status(400)
      .json({ error: `assetType must be one of: ${VALID_ASSET_TYPES.join(', ')}` });
  }
  if (Number(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be greater than 0' });
  }
  if (Number(buyPrice) < 0) {
    return res.status(400).json({ error: 'buyPrice cannot be negative' });
  }
  if (isFutureDate(buyDate)) {
    return res.status(400).json({ error: 'buyDate cannot be in the future' });
  }

  const normalizedTicker = normalizeTickerForStorage(ticker, assetType);

  // Validates against historical price; skips if user confirmed "Add anyway"
  if (!confirmPrice) {
    const priceCheck = await validateBuyPrice(
      normalizedTicker,
      assetType,
      Number(buyPrice),
      buyDate
    );
    if (!priceCheck.valid) {
      return res.status(400).json({
        error: priceCheck.message,
        priceMismatch: true,
        historicalPrice: priceCheck.historicalPrice,
      });
    }
  }

  const holding = await Holding.create({
    user: req.user._id,
    ticker: normalizedTicker,
    assetType,
    quantity,
    buyPrice,
    buyDate,
    note,
  });

  res.status(201).json(holding);
});

exports.getAll = asyncHandler(async (req, res) => {
  const holdings = await Holding.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json(holdings);
});

exports.getOne = asyncHandler(async (req, res) => {
  const holding = await Holding.findOne({ _id: req.params.id, user: req.user._id });
  if (!holding) return res.status(404).json({ error: 'Holding not found' });
  res.json(holding);
});

exports.update = asyncHandler(async (req, res) => {
  const { ticker, assetType, quantity, buyPrice, buyDate, note, confirmPrice } = req.body;

  if (ticker !== undefined && !String(ticker).trim()) {
    return res.status(400).json({ error: 'ticker cannot be empty' });
  }
  if (assetType && !VALID_ASSET_TYPES.includes(assetType)) {
    return res
      .status(400)
      .json({ error: `assetType must be one of: ${VALID_ASSET_TYPES.join(', ')}` });
  }
  if (quantity !== undefined && Number(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be greater than 0' });
  }
  if (buyPrice !== undefined && Number(buyPrice) < 0) {
    return res.status(400).json({ error: 'buyPrice cannot be negative' });
  }
  if (buyDate !== undefined && isFutureDate(buyDate)) {
    return res.status(400).json({ error: 'buyDate cannot be in the future' });
  }

  const holding = await Holding.findOne({ _id: req.params.id, user: req.user._id });
  if (!holding) return res.status(404).json({ error: 'Holding not found' });

  // Same normalization as create — the final ticker depends on the final
  // assetType, which may be changing in this same request.
  const nextAssetType = assetType ?? holding.assetType;
  const nextTicker = normalizeTickerForStorage(ticker ?? holding.ticker, nextAssetType);
  const nextBuyPrice = buyPrice !== undefined ? Number(buyPrice) : holding.buyPrice;
  const nextBuyDate = buyDate !== undefined ? new Date(buyDate) : holding.buyDate;

  const identityChanged = nextTicker !== holding.ticker || nextAssetType !== holding.assetType;
  const priceInputsChanged =
    identityChanged ||
    nextBuyPrice !== holding.buyPrice ||
    nextBuyDate.getTime() !== new Date(holding.buyDate).getTime();

  if (priceInputsChanged && !confirmPrice) {
    const priceCheck = await validateBuyPrice(nextTicker, nextAssetType, nextBuyPrice, nextBuyDate);
    if (!priceCheck.valid) {
      return res.status(400).json({
        error: priceCheck.message,
        priceMismatch: true,
        historicalPrice: priceCheck.historicalPrice,
      });
    }
  }

  holding.ticker = nextTicker;
  holding.assetType = nextAssetType;
  holding.buyPrice = nextBuyPrice;
  holding.buyDate = nextBuyDate;
  if (quantity !== undefined) holding.quantity = quantity;
  if (note !== undefined) holding.note = note;

  // The stored price belonged to the old ticker; clear it so the UI shows
  // "—" until the next sync instead of a wrong number.
  if (identityChanged) {
    holding.currentPrice = null;
    holding.priceUpdatedAt = null;
  }

  await holding.save();
  res.json(holding);
});

exports.remove = asyncHandler(async (req, res) => {
  const deleted = await Holding.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!deleted) return res.status(404).json({ error: 'Holding not found' });
  res.json({ message: 'Holding deleted' });
});
