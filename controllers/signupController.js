const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const User = require('../models/user');
const PendingSignup = require('../models/PendingSignup');
const asyncHandler = require('../utils/asyncHandler');
const { generateToken, generateTempToken, verifyToken } = require('../utils/jwt');
const { isValidEmail, newCode } = require('../utils/emailCode');
const { sendVerificationCode } = require('../utils/mailer');
const tf = require('../utils/twoFactor');
const { passwordProblem, nameProblem } = require('../utils/validate');

const CODE_TTL_MS = 10 * 60 * 1000;
const FLOW_TTL_MS = 30 * 60 * 1000; // after the email is verified, time to scan the QR
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

// Step 1 — POST /api/auth/signup { name, email, password }
// Validates, stores a pending signup and emails a 6-digit code. No User yet.
exports.start = asyncHandler(async (req, res) => {
  const { name, password } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  const badName = nameProblem(name);
  if (badName) return res.status(400).json({ error: badName });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const badPassword = passwordProblem(password);
  if (badPassword) return res.status(400).json({ error: badPassword });
  if (await User.exists({ email })) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const prior = await PendingSignup.findOne({ email });
  if (prior && Date.now() - prior.lastSentAt < RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: 'A code was just sent. Wait a minute before requesting another.' });
  }

  const { code, hash } = await newCode();
  await PendingSignup.findOneAndUpdate(
    { email },
    {
      email, name: String(name).trim(), passwordHash: await bcrypt.hash(password, 10), codeHash: hash,
      attempts: 0, lastSentAt: new Date(), emailVerified: false, $unset: { totpSecret: 1 },
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  try {
    await sendVerificationCode(email, code);
  } catch (err) {
    console.error('Verification email failed:', err.message);
    await PendingSignup.deleteOne({ email });
    return res.status(502).json({ error: "Couldn't send the verification email. Check the address and try again." });
  }
  res.json({ verificationRequired: true });
});

// Step 2 — POST /api/auth/signup/verify { email, code }
// Correct code → returns the authenticator QR and a short-lived setupToken.
exports.verifyEmail = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const pending = await PendingSignup.findOne({ email });
  if (!pending || pending.emailVerified || pending.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Code expired. Please sign up again.' });
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    await pending.deleteOne();
    return res.status(429).json({ error: 'Too many wrong codes. Please sign up again.' });
  }
  if (!/^\d{6}$/.test(code) || !(await bcrypt.compare(code, pending.codeHash))) {
    pending.attempts++;
    await pending.save();
    return res.status(400).json({ error: 'Invalid code' });
  }

  const secret = tf.generateSecret();
  const otpauthUrl = tf.generateURI({ issuer: 'WealthLens', label: email, secret });
  pending.emailVerified = true;
  pending.totpSecret = tf.encrypt(secret);
  pending.expiresAt = new Date(Date.now() + FLOW_TTL_MS);
  await pending.save();

  res.json({
    setupToken: generateTempToken(pending._id, 'signup-2fa', '30m'),
    qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl),
    otpauthUrl,
  });
});

// Step 3 — POST /api/auth/signup/complete { setupToken, code }
// Authenticator code confirmed → create the User with 2FA on, return session + backup codes once.
exports.complete = asyncHandler(async (req, res) => {
  const { setupToken } = req.body;
  const code = String(req.body.code || '').trim();
  let decoded;
  try {
    decoded = verifyToken(setupToken);
  } catch {
    return res.status(401).json({ error: 'Setup expired. Please sign up again.' });
  }
  if (decoded.purpose !== 'signup-2fa') return res.status(401).json({ error: 'Invalid token' });

  const pending = await PendingSignup.findById(decoded.id);
  if (!pending || !pending.emailVerified) return res.status(401).json({ error: 'Setup expired. Please sign up again.' });
  if (tf.isLocked(pending._id)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 10 minutes.' });

  const step = tf.checkTotp(tf.decrypt(pending.totpSecret), code);
  if (step === null) {
    tf.recordFail(pending._id);
    return res.status(400).json({ error: 'Invalid code' });
  }
  tf.clearFails(pending._id);

  const { plain, hashes } = await tf.generateBackupCodes();
  const user = new User({
    name: pending.name, email: pending.email, password: pending.passwordHash,
    twoFactorEnabled: true, twoFactorSecret: pending.totpSecret,
    twoFactorBackupCodes: hashes, twoFactorLastUsedStep: step,
  });
  user.$locals.passwordHashed = true; // already bcrypt-hashed in step 1
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An account with this email already exists' });
    throw err;
  }
  await pending.deleteOne();

  res.status(201).json({
    token: generateToken(user._id),
    user: { id: user._id, name: user.name, email: user.email },
    backupCodes: plain,
  });
});
