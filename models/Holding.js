const mongoose = require('mongoose');

const VALID_ASSET_TYPES = ['STOCK', 'MUTUAL_FUND', 'BOND', 'ETF', 'GOLD', 'CRYPTO', 'OTHER'];

// Asset types that yahoo-finance2 can fetch prices for.
// MUTUAL_FUND and BOND are excluded — no clean free live-price source for them yet.
const PRICE_SYNCABLE_TYPES = ['STOCK', 'ETF', 'GOLD', 'CRYPTO'];

// GOLD mixes exchange-traded gold (GOLDBEES.NS) with holdings that have no
// market ticker at all (SGB, PHYSICALGOLD, DIGITALGOLD, GOLDFUND). Only the
// ones carrying an exchange suffix have a Yahoo price. Every caller that
// fetches prices or history goes through this, so the rule lives in one place.
function isPriceSyncable(ticker, assetType) {
  if (!PRICE_SYNCABLE_TYPES.includes(assetType)) return false;
  if (assetType === 'GOLD') return String(ticker).includes('.');
  return true;
}

const holdingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ticker: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    assetType: {
      type: String,
      required: true,
      enum: VALID_ASSET_TYPES,
      default: 'STOCK',
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.0001,
    },
    buyPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    buyDate: {
      type: Date,
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    // Populated by the price sync job. Null until the first sync runs.
    currentPrice: {
      type: Number,
      default: null,
    },
    priceUpdatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Holding', holdingSchema);
module.exports.VALID_ASSET_TYPES = VALID_ASSET_TYPES;
module.exports.PRICE_SYNCABLE_TYPES = PRICE_SYNCABLE_TYPES;
module.exports.isPriceSyncable = isPriceSyncable;
