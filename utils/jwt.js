const jwt = require('jsonwebtoken');

// Pin the algorithm on both sides so a token can never pick its own (e.g. "none").
const ALG = 'HS256';

const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    algorithm: ALG,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// Short-lived token proving the password step passed; only /2fa/verify-login accepts it.
const generateTempToken = (id, purpose = '2fa', expiresIn = '5m') =>
  jwt.sign({ id, purpose }, process.env.JWT_SECRET, { algorithm: ALG, expiresIn });

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET, { algorithms: [ALG] });

module.exports = { generateToken, generateTempToken, verifyToken };
