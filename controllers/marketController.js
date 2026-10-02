const { getMarketStatus } = require('../services/marketStatus');

exports.getStatus = (req, res) => {
  const status = getMarketStatus();
  res.json(status);
};
