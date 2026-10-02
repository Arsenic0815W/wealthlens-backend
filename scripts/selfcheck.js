// Offline check for the two pieces of pure logic most likely to regress.
// Run: node scripts/selfcheck.js   (no DB or network needed)
const assert = require('assert');
const { parseAmfiNavText, findBestMatch } = require('../services/mfNavSync');
const { buildHistorySeries } = require('../services/portfolioHistory');
const { normalizeTicker } = require('../services/priceSync');
const { isPriceSyncable } = require('../models/Holding');

const classic = [
  'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
  '',
  'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
  'PPFAS Mutual Fund',
  '122639;INF879O01027;-;Parag Parikh Flexi Cap Fund - Direct Plan - Growth;95.1234;29-Sep-2026',
  '122640;INF879O01019;-;Parag Parikh Flexi Cap Fund - Regular Plan - Growth;85.4321;29-Sep-2026',
  '999999;-;-;Some Wound Up Fund;N.A.;29-Sep-2026',
].join('\r\n');
const rows = parseAmfiNavText(classic);
assert.strictEqual(rows.length, 2, 'classic format should yield 2 data rows');
assert.strictEqual(
  findBestMatch('Parag Parikh Flexi Cap Fund', rows).nav,
  95.1234,
  'should prefer Direct Growth'
);

const wide = [
  'Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
  '1;-;-;Axis Bluechip Fund;Regular;Growth;50.5;29-Sep-2026',
  '2;-;-;Axis Bluechip Fund;Direct;Growth;55.5;29-Sep-2026',
].join('\n');
assert.strictEqual(findBestMatch('Axis Bluechip Fund', parseAmfiNavText(wide)).nav, 55.5);

// History: a crypto-only Saturday must not drop the stock's value
const closes = new Map([
  [
    'TCS.NS',
    [
      ['2026-09-25', 100],
      ['2026-09-28', 110],
    ],
  ], // Fri, Mon
  [
    'BTC-INR',
    [
      ['2026-09-25', 10],
      ['2026-09-26', 11],
      ['2026-09-27', 12],
      ['2026-09-28', 13],
    ],
  ],
]);
const series = buildHistorySeries(
  [
    { symbol: 'TCS.NS', quantity: 1, buyKey: '2026-09-25' },
    { symbol: 'BTC-INR', quantity: 1, buyKey: '2026-09-25' },
  ],
  closes
);
assert.deepStrictEqual(
  series.map((p) => p.value),
  [110, 111, 112, 123],
  "weekend points should carry Friday's stock close forward"
);

// Crypto is always priced in INR; non-exchange gold is never synced
assert.strictEqual(normalizeTicker('BTC', 'CRYPTO'), 'BTC-INR');
assert.strictEqual(normalizeTicker('ETH-USD', 'CRYPTO'), 'ETH-INR');
assert.strictEqual(isPriceSyncable('SGB', 'GOLD'), false);
assert.strictEqual(isPriceSyncable('GOLDBEES.NS', 'GOLD'), true);

process.env.TWO_FACTOR_ENC_KEY = 'ab'.repeat(32);
process.env.JWT_SECRET = 'selfcheck-secret';
const { generateSync } = require('otplib');
const tf = require('../utils/twoFactor');
const { generateTempToken, generateToken } = require('../utils/jwt');
const authMiddleware = require('../middleware/auth');

(async () => {
  const secret = tf.generateSecret();
  const stored = tf.encrypt(secret);
  assert.notStrictEqual(stored, secret);
  assert.strictEqual(tf.decrypt(stored), secret);
  assert.throws(() => tf.decrypt(stored.slice(0, -2) + (stored.endsWith('00') ? '11' : '00')));

  const user = { twoFactorSecret: stored, twoFactorBackupCodes: [], twoFactorLastUsedStep: 0 };
  const now = Date.now();
  const at = (ms) => generateSync({ secret, epoch: Math.floor(ms / 1000) });
  assert.strictEqual(await tf.consumeCode(user, at(now), now), true, 'current code accepted');
  assert.strictEqual(await tf.consumeCode(user, at(now), now), false, 'replayed code rejected');
  assert.strictEqual(await tf.consumeCode(user, at(now - 30000), now), false, 'earlier step rejected');
  assert.strictEqual(await tf.consumeCode(user, at(now + 30000), now), true, 'next step (+1 drift) accepted');
  assert.strictEqual(tf.checkTotp(secret, at(now - 90000), now), null, '3 steps old rejected');
  assert.strictEqual(tf.checkTotp(secret, at(now + 90000), now), null, '3 steps ahead rejected');

  const { plain, hashes } = await tf.generateBackupCodes();
  assert.strictEqual(plain.length, 8);
  user.twoFactorBackupCodes = hashes;
  assert.strictEqual(await tf.consumeCode(user, plain[0].toUpperCase()), true);
  assert.strictEqual(user.twoFactorBackupCodes.length, 7);
  assert.strictEqual(await tf.consumeCode(user, plain[0]), false, 'backup code reuse rejected');

  for (let i = 0; i < 5; i++) tf.recordFail('u1');
  assert.strictEqual(tf.isLocked('u1'), true);
  tf.clearFails('u1');
  assert.strictEqual(tf.isLocked('u1'), false);

  const run = async (token) => {
    let out = {};
    const res = { status: (c) => ({ json: (b) => (out = { status: c, body: b }) }) };
    await authMiddleware({ headers: { authorization: `Bearer ${token}` } }, res, () => (out = { next: true }));
    return out;
  };
  const rejected = await run(generateTempToken('507f1f77bcf86cd799439011'));
  assert.strictEqual(rejected.status, 401, '2fa temp token must be rejected');
  assert.strictEqual(require('jsonwebtoken').decode(generateToken('x')).purpose, undefined);

  const { isValidEmail, newCode } = require('../utils/emailCode');
  assert.strictEqual(isValidEmail('a@b.co'), true);
  for (const bad of ['random', 'a@b', 'a b@c.com', '@x.com', 'a@b.c']) assert.strictEqual(isValidEmail(bad), false, bad);
  const ec = await newCode();
  assert.match(ec.code, /^\d{6}$/);
  assert.strictEqual(await require('bcryptjs').compare(ec.code, ec.hash), true);
  assert.strictEqual((await run(generateTempToken('507f1f77bcf86cd799439011', 'signup-2fa'))).status, 401);

  console.log('selfcheck passed');
})().catch((e) => { console.error(e); process.exit(1); });
