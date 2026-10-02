const { getMarketStatus } = require('../services/marketStatus');

// GET /api/market/status
exports.getStatus = (req, res) => {
  const status = getMarketStatus();
  res.json(status);
};
