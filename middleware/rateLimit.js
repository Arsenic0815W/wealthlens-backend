const { rateLimit } = require('express-rate-limit');

// Per-IP limits, on top of the per-account lockouts in utils/twoFactor.js.
// Those stop guessing one account's password; these stop one client from
// spraying many accounts or using signup to send emails to arbitrary addresses.
//
// pönytail: in-memory store - resets on restart and isn't shared across instances.
// Upgrade path: a shared store (e.g. Redis via rate-limit-redis) if you scale out.
//
// Jest sets NODE_ENV=test; the API suite runs many auth calls from one IP, so
// limits are off there unless a test opts in with ENABLE_RATE_LIMIT_IN_TESTS=1.
const skip = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== '1';

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    message: { error: message },
  });

const MIN = 60 * 1000;

// Everything under /api: generous, only stops floods and scripted scraping.
exports.apiLimiter = limiter(15 * MIN, 600, 'Too many requests. Please slow down and try again shortly.');

// Login, code verification and 2FA changes: blocks credential stuffing across accounts.
exports.authLimiter = limiter(15 * MIN, 30, 'Too many attempts from this network. Try again in 15 minutes.');

// Signup step 1 sends an email: stops the server being used to email strangers.
exports.signupEmailLimiter = limiter(60 * MIN, 5, 'Too many signup attempts from this network. Try again in an hour.');
