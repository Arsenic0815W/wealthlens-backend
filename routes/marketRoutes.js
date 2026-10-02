const express = require('express');
const router = express.Router();
const { getStatus } = require('../controllers/marketController');
const auth = require('../middleware/auth');

router.get('/status', auth, getStatus);

module.exports = router;
