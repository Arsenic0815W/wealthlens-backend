const jwt = require('jsonwebtoken');

const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// Short-lived token proving the password step passed; only /2fa/verify-login accepts it.
const generateTempToken = (id, purpose = '2fa', expiresIn = '5m') =>
  jwt.sign({ id, purpose }, process.env.JWT_SECRET, { expiresIn });

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

module.exports = { generateToken, generateTempToken, verifyToken };
