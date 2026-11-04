const User = require('../models/user');
const { generateToken, generateTempToken } = require('../utils/jwt');
const asyncHandler = require('../utils/asyncHandler');
const tf = require('../utils/twoFactor');
const { isStr, nameProblem } = require('../utils/validate');
const { isValidEmail } = require('../utils/emailCode');

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!isStr(email) || !isStr(password) || !email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  // Keyed on email (prefixed so it can't collide with the user-id keys the 2FA
  // routes use); unknown emails count too, so lockout doesn't reveal which exist.
  const failKey = `login:${String(email).toLowerCase()}`;
  if (tf.isLocked(failKey)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 10 minutes.' });
  }

  // .select('+password') needed since the schema excludes it by default
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    tf.recordFail(failKey);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  tf.clearFails(failKey);

  if (user.twoFactorEnabled) {
    return res.json({ twoFactorRequired: true, tempToken: generateTempToken(user._id) });
  }

  const token = generateToken(user._id);

  res.json({
    token,
    user: { id: user._id, name: user.name, email: user.email },
  });
});

exports.getMe = asyncHandler(async (req, res) => {
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    createdAt: req.user.createdAt,
    twoFactorEnabled: req.user.twoFactorEnabled,
  });
});

exports.updateMe = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  const updates = {};
  if (name !== undefined) {
    const problem = nameProblem(name);
    if (problem) return res.status(400).json({ error: problem });
    updates.name = name.trim();
  }
  if (email !== undefined) {
    const normalized = isStr(email) ? email.trim().toLowerCase() : '';
    if (!isValidEmail(normalized)) return res.status(400).json({ error: 'Enter a valid email address' });
    updates.email = normalized;
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true,
    runValidators: true,
  });

  res.json({ id: user._id, name: user.name, email: user.email });
});
