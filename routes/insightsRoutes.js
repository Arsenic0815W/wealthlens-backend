const express = require('express');
const router = express.Router();
const {
  getAllocation,
  evaluateHolding,
  getPortfolioHistoryHandler,
} = require('../controllers/insightsController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/allocation', getAllocation);
router.post('/evaluate/:id', evaluateHolding);
router.get('/portfolio-history', getPortfolioHistoryHandler);

module.exports = router;
