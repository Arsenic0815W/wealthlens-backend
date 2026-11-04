const express = require('express');
const router = express.Router();
const { login, getMe, updateMe } = require('../controllers/authController');
const signupFlow = require('../controllers/signupController');
const auth = require('../middleware/auth');
const { authLimiter, signupEmailLimiter } = require('../middleware/rateLimit');

router.post('/signup', signupEmailLimiter, authLimiter, signupFlow.start);
router.post('/signup/verify', authLimiter, signupFlow.verifyEmail);
router.post('/signup/complete', authLimiter, signupFlow.complete);
router.post('/login', authLimiter, login);
const twoFactor = require('../controllers/twoFactorController');
router.post('/2fa/setup', auth, twoFactor.setup);
router.post('/2fa/enable', authLimiter, auth, twoFactor.enable);
router.post('/2fa/disable', authLimiter, auth, twoFactor.disable);
router.post('/2fa/verify-login', authLimiter, twoFactor.verifyLogin);

router.get('/me', auth, getMe);
router.put('/me', auth, updateMe);

module.exports = router;
