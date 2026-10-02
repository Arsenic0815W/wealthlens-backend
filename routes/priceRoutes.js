const express = require('express');
const router = express.Router();
const { triggerSync } = require('../controllers/priceController');
const auth = require('../middleware/auth');

router.post('/sync', auth, triggerSync);

module.exports = router;
