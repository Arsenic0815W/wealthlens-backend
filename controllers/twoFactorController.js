const QRCode = require('qrcode');
const User = require('../models/user');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken, verifyToken } = require('../utils/jwt');
const tf = require('../utils/twoFactor');

const SECRET_FIELDS = '+twoFactorSecret +pendingTwoFactorSecret +twoFactorBackupCodes +twoFactorLastUsedStep';
const TOO_MANY = { error: 'Too many failed attempts. Try again in 10 minutes.' };

// POST /api/auth/2fa/setup
exports.setup = asyncHandler(async (req, res) => {
  if (req.user.twoFactorEnabled) return res.status(409).json({ error: '2FA is already enabled' });
  const secret = tf.generateSecret();
  const otpauthUrl = tf.generateURI({ issuer: 'WealthLens', label: req.user.email, secret });
  await User.updateOne({ _id: req.user._id }, { pendingTwoFactorSecret: tf.encrypt(secret) });
  res.json({ qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl), otpauthUrl });
});

// POST /api/auth/2fa/enable  { code }
exports.enable = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(SECRET_FIELDS);
  if (user.twoFactorEnabled) return res.status(409).json({ error: '2FA is already enabled' });
  if (!user.pendingTwoFactorSecret) return res.status(400).json({ error: 'Start setup first' });
  if (tf.isLocked(user._id)) return res.status(429).json(TOO_MANY);

  const step = tf.checkTotp(tf.decrypt(user.pendingTwoFactorSecret), String(req.body.code || '').trim());
  if (step === null) {
    tf.recordFail(user._id);
    return res.status(400).json({ error: 'Invalid code' });
  }
  tf.clearFails(user._id);

  const { plain, hashes } = await tf.generateBackupCodes();
  user.twoFactorSecret = user.pendingTwoFactorSecret;
  user.pendingTwoFactorSecret = undefined;
  user.twoFactorEnabled = true;
  user.twoFactorLastUsedStep = step;
  user.twoFactorBackupCodes = hashes;
  await user.save();
  res.json({ backupCodes: plain });
});

// POST /api/auth/2fa/disable  { password, code }
exports.disable = asyncHandler(async (req, res) => {
  const { password, code } = req.body;
  if (!password || !code) return res.status(400).json({ error: 'password and code are required' });

  const user = await User.findById(req.user._id).select(`+password ${SECRET_FIELDS}`);
  if (!user.twoFactorEnabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (tf.isLocked(user._id)) return res.status(429).json(TOO_MANY);

  if (!(await user.comparePassword(password)) || !(await tf.consumeCode(user, code))) {
    tf.recordFail(user._id);
    return res.status(401).json({ error: 'Invalid password or code' });
  }
  tf.clearFails(user._id);

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.pendingTwoFactorSecret = undefined;
  user.twoFactorBackupCodes = [];
  user.twoFactorLastUsedStep = undefined;
  await user.save();
  res.json({ ok: true });
});

// POST /api/auth/2fa/verify-login  { tempToken, code }
exports.verifyLogin = asyncHandler(async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'tempToken and code are required' });

  let decoded;
  try {
    decoded = verifyToken(tempToken);
  } catch {
    return res.status(401).json({ error: 'Login step expired, please log in again' });
  }
  if (decoded.purpose !== '2fa') return res.status(401).json({ error: 'Invalid token' });

  const user = await User.findById(decoded.id).select(SECRET_FIELDS);
  if (!user || !user.twoFactorEnabled) return res.status(401).json({ error: 'Invalid token' });
  if (tf.isLocked(user._id)) return res.status(429).json(TOO_MANY);

  if (!(await tf.consumeCode(user, code))) {
    tf.recordFail(user._id);
    return res.status(401).json({ error: 'Invalid code' });
  }
  tf.clearFails(user._id);
  await user.save();

  res.json({
    token: generateToken(user._id),
    user: { id: user._id, name: user.name, email: user.email },
  });
});
