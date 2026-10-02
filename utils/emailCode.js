const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isValidEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);

// 6-digit emailed code; only the bcrypt hash is stored.
async function newCode() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  return { code, hash: await bcrypt.hash(code, 8) };
}

module.exports = { isValidEmail, newCode };
