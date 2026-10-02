const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { generateSecret, generateURI, verifySync } = require('otplib');

// The key is read on first use, so servers without it still boot; only 2FA routes fail.
function getKey() {
  const hex = process.env.TWO_FACTOR_ENC_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'TWO_FACTOR_ENC_KEY is missing or invalid: it must be 32 bytes as 64 hex chars. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

// AES-256-GCM, stored as iv:tag:ciphertext (hex)
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('hex')).join(':');
}

function decrypt(stored) {
  const [iv, tag, enc] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ±1 time step (30s) of drift, no more. Returns the matched step or null.
function checkTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const r = verifySync({ secret, token: code, epochTolerance: 30, epoch: Math.floor(now / 1000) });
  return r.valid ? r.timeStep : null;
}

const normalizeBackup = (c) => String(c).toLowerCase().replace(/[\s-]/g, '');

async function generateBackupCodes() {
  const plain = Array.from({ length: 8 }, () => {
    const c = crypto.randomBytes(5).toString('hex'); // 10 chars
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  const hashes = await Promise.all(plain.map((c) => bcrypt.hash(normalizeBackup(c), 8)));
  return { plain, hashes };
}

// Verifies a TOTP (with replay protection) or a backup code (single use) and
// mutates the user doc accordingly. Caller must have selected the 2FA fields
// and must save(). Returns true/false.
async function consumeCode(user, code, now = Date.now()) {
  code = String(code || '').trim();
  if (/^\d{6}$/.test(code)) {
    const step = checkTotp(decrypt(user.twoFactorSecret), code, now);
    if (step === null || step <= (user.twoFactorLastUsedStep || 0)) return false;
    user.twoFactorLastUsedStep = step;
    return true;
  }
  const norm = normalizeBackup(code);
  for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
    if (await bcrypt.compare(norm, user.twoFactorBackupCodes[i])) {
      user.twoFactorBackupCodes.splice(i, 1);
      return true;
    }
  }
  return false;
}

// pönytail: in-memory and per-process — resets on restart, not shared across instances —
// upgrade path: a shared store (Redis) or a Mongo TTL collection.
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000;
const fails = new Map(); // userId -> { count, resetAt }

function isLocked(userId, now = Date.now()) {
  const f = fails.get(String(userId));
  if (!f || f.resetAt <= now) return false;
  return f.count >= MAX_FAILS;
}
function recordFail(userId, now = Date.now()) {
  const k = String(userId);
  const f = fails.get(k);
  if (!f || f.resetAt <= now) fails.set(k, { count: 1, resetAt: now + WINDOW_MS });
  else f.count++;
}
const clearFails = (userId) => fails.delete(String(userId));

module.exports = {
  encrypt, decrypt, checkTotp, generateBackupCodes, consumeCode,
  isLocked, recordFail, clearFails, generateSecret, generateURI,
};
