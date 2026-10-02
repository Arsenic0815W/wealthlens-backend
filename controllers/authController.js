const User = require('../models/user');
const { generateToken, generateTempToken } = require('../utils/jwt');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/auth/login
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  // .select('+password') needed since the schema excludes it by default
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.twoFactorEnabled) {
    return res.json({ twoFactorRequired: true, tempToken: generateTempToken(user._id) });
  }

  const token = generateToken(user._id);

  res.json({
    token,
    user: { id: user._id, name: user.name, email: user.email },
  });
});

// GET /api/auth/me
exports.getMe = asyncHandler(async (req, res) => {
  // req.user set by auth middleware
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    createdAt: req.user.createdAt,
    twoFactorEnabled: req.user.twoFactorEnabled,
  });
});

// PUT /api/auth/me
exports.updateMe = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email.toLowerCase();

  const user = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true, // return the updated document, not the original
    runValidators: true, // re-run schema validation on update
  });

  res.json({ id: user._id, name: user.name, email: user.email });
});
