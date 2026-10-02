const express = require('express');
const router = express.Router();
const { login, getMe, updateMe } = require('../controllers/authController');
const signupFlow = require('../controllers/signupController');
const auth = require('../middleware/auth');

router.post('/signup', signupFlow.start);
router.post('/signup/verify', signupFlow.verifyEmail);
router.post('/signup/complete', signupFlow.complete);
router.post('/login', login);
const twoFactor = require('../controllers/twoFactorController');
router.post('/2fa/setup', auth, twoFactor.setup);
router.post('/2fa/enable', auth, twoFactor.enable);
router.post('/2fa/disable', auth, twoFactor.disable);
router.post('/2fa/verify-login', twoFactor.verifyLogin);

router.get('/me', auth, getMe);
router.put('/me', auth, updateMe);

module.exports = router;
