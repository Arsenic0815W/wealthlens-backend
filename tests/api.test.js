// Run: npm test. In-memory MongoDB; Yahoo Finance and the mailer are mocked, so no network or real DB.
process.env.JWT_SECRET = 'test-secret';
process.env.TWO_FACTOR_ENC_KEY = 'a'.repeat(64);
delete process.env.FRONTEND_URL;

jest.mock('../utils/yahooFinance', () => ({ chart: jest.fn(), quote: jest.fn() }));
jest.mock('../utils/mailer', () => ({ sendVerificationCode: jest.fn().mockResolvedValue() }));
// otplib's dependencies are ESM-only, which Jest can't load before Node 24.9. Stand-in: plain RFC 6238 TOTP.
jest.mock('otplib', () => {
  const crypto = require('crypto');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const b32 = (buf) => [...buf].map((b) => b.toString(2).padStart(8, '0')).join('').match(/.{1,5}/g)
    .map((c) => A[parseInt(c.padEnd(5, '0'), 2)]).join('');
  const unb32 = (s) => Buffer.from(s.split('').map((c) => A.indexOf(c).toString(2).padStart(5, '0')).join('')
    .match(/.{8}/g).map((b) => parseInt(b, 2)));
  const at = (secret, step) => {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac('sha1', unb32(secret)).update(msg).digest();
    const o = h[19] & 15;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
  };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    generateSecret: () => b32(crypto.randomBytes(20)),
    generateURI: ({ issuer, label, secret }) => `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`,
    generateSync: ({ secret }) => at(secret, Math.floor(now() / 30)),
    verifySync: ({ secret, token, epochTolerance = 0, epoch = now() }) => {
      const base = Math.floor(epoch / 30);
      for (const step of [base, base - 1, base + 1].slice(0, epochTolerance ? 3 : 1)) {
        if (at(secret, step) === token) return { valid: true, timeStep: step };
      }
      return { valid: false };
    },
  };
});

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const { generateSync } = require('otplib');
const { MongoMemoryServer } = require('mongodb-memory-server');

const yahoo = require('../utils/yahooFinance');
const mailer = require('../utils/mailer');
const User = require('../models/user');
const Holding = require('../models/Holding');
const { generateToken, generateTempToken } = require('../utils/jwt');
const { evaluatePurchase } = require('../services/purchaseEvaluator');
const { buildHistorySeries } = require('../services/portfolioHistory');
const app = require('../server');

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Holding.deleteMany({})]);
  yahoo.chart.mockReset().mockResolvedValue({ quotes: [] }); // no history -> price check fails open
  yahoo.quote.mockReset();
  mailer.sendVerificationCode.mockClear();
});

let n = 0;
async function makeUser() {
  const user = await User.create({ name: 'T', email: `u${++n}@test.com`, password: 'secret123' });
  return { user, auth: { Authorization: `Bearer ${generateToken(user._id)}` } };
}
const holdingBody = (over = {}) => ({
  ticker: 'TCS', assetType: 'STOCK', quantity: 2, buyPrice: 100, buyDate: '2026-01-15', ...over,
});
const addHolding = (u, body) => request(app).post('/api/holdings').set(u.auth).send(holdingBody(body));

describe('auth: signup and login', () => {
  test('signup runs email code -> authenticator -> account, then login asks for 2FA', async () => {
    const email = 'new@test.com';
    const password = 'secret123';

    let res = await request(app).post('/api/auth/signup').send({ name: 'New', email, password });
    expect(res.status).toBe(200);
    const code = mailer.sendVerificationCode.mock.calls.at(-1)[1];

    res = await request(app).post('/api/auth/signup/verify').send({ email, code });
    expect(res.status).toBe(200);
    const secret = new URL(res.body.otpauthUrl).searchParams.get('secret');

    res = await request(app)
      .post('/api/auth/signup/complete')
      .send({ setupToken: res.body.setupToken, code: generateSync({ secret }) });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.backupCodes).toHaveLength(8);

    res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  test('login without 2FA returns a token that opens /me, and never exposes the password hash', async () => {
    await User.create({ name: 'A', email: 'a@test.com', password: 'secret123' });
    const login = await request(app).post('/api/auth/login').send({ email: 'A@Test.com', password: 'secret123' });
    expect(login.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('a@test.com');
    expect(JSON.stringify(me.body)).not.toMatch(/password/i);
  });

  test('wrong password and unknown email both return the same 401', async () => {
    await User.create({ name: 'A', email: 'b@test.com', password: 'secret123' });
    const wrong = await request(app).post('/api/auth/login').send({ email: 'b@test.com', password: 'nope-nope' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@test.com', password: 'secret123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('JWT protection', () => {
  test('401 with no Authorization header', async () => {
    expect((await request(app).get('/api/holdings')).status).toBe(401);
  });

  test('401 when the payload is tampered (signature no longer matches)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const [h, , s] = generateToken(a.user._id).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ id: String(b.user._id) })).toString('base64url');
    const res = await request(app).get('/api/holdings').set('Authorization', `Bearer ${h}.${forgedPayload}.${s}`);
    expect(res.status).toBe(401);
  });

  test('401 when signed with a different secret, expired, or garbage', async () => {
    const { user } = await makeUser();
    const forged = jwt.sign({ id: user._id }, 'other-secret');
    const expired = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: -10 });
    for (const t of [forged, expired, 'not.a.jwt']) {
      const res = await request(app).get('/api/holdings').set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(401);
    }
  });

  test('a 2FA temp token cannot open normal routes', async () => {
    const { user } = await makeUser();
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${generateTempToken(user._id)}`);
    expect(res.status).toBe(401);
  });
});

describe('holding ownership: user A cannot touch user B\'s holding', () => {
  test('read, update and delete return 404 and leave the holding intact', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { body: h } = await addHolding(a);

    const get = await request(app).get(`/api/holdings/${h._id}`).set(b.auth);
    const put = await request(app).put(`/api/holdings/${h._id}`).set(b.auth).send({ note: 'hacked' });
    const del = await request(app).delete(`/api/holdings/${h._id}`).set(b.auth);
    expect([get.status, put.status, del.status]).toEqual([404, 404, 404]);

    const still = await request(app).get(`/api/holdings/${h._id}`).set(a.auth);
    expect(still.status).toBe(200);
    expect(still.body.note).toBeUndefined();
    expect((await request(app).get('/api/holdings').set(b.auth)).body).toEqual([]);
  });
});

describe('invalid input returns 400', () => {
  const bad = {
    'missing required fields': { ticker: 'TCS' },
    'unknown assetType': { assetType: 'NFT' },
    'zero quantity': { quantity: 0 },
    'negative buyPrice': { buyPrice: -5 },
    'future buyDate': { buyDate: '2999-01-01' },
  };
  test.each(Object.entries(bad))('create holding: %s', async (_name, over) => {
    const u = await makeUser();
    const body = _name === 'missing required fields' ? over : holdingBody(over);
    const res = await request(app).post('/api/holdings').set(u.auth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('malformed holding id and malformed JSON body', async () => {
    const u = await makeUser();
    expect((await request(app).get('/api/holdings/not-an-id').set(u.auth)).status).toBe(400);
    const res = await request(app).post('/api/holdings').set(u.auth).set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
  });

  test('signup rejects short password and bad email', async () => {
    const short = await request(app).post('/api/auth/signup').send({ name: 'x', email: 'x@test.com', password: '123' });
    const email = await request(app).post('/api/auth/signup').send({ name: 'x', email: 'nope', password: 'secret123' });
    expect([short.status, email.status]).toEqual([400, 400]);
    expect(mailer.sendVerificationCode).not.toHaveBeenCalled();
  });
});

describe('buy-price mismatch warning', () => {
  test('far-off price is rejected with priceMismatch, then accepted with confirmPrice', async () => {
    yahoo.chart.mockResolvedValue({ quotes: [{ date: new Date('2026-01-15T00:00:00Z'), close: 100 }] });
    const u = await makeUser();

    const warn = await addHolding(u, { buyPrice: 200 });
    expect(warn.status).toBe(400);
    expect(warn.body.priceMismatch).toBe(true);
    expect(warn.body.historicalPrice).toBe(100);
    expect(await Holding.countDocuments()).toBe(0);

    const retry = await addHolding(u, { buyPrice: 200, confirmPrice: true });
    expect(retry.status).toBe(201);
    expect(await Holding.countDocuments()).toBe(1);
  });

  test('a price within the 10% tolerance needs no confirmation', async () => {
    yahoo.chart.mockResolvedValue({ quotes: [{ date: new Date('2026-01-15T00:00:00Z'), close: 100 }] });
    const res = await addHolding(await makeUser(), { buyPrice: 105 });
    expect(res.status).toBe(201);
  });
});

describe('allocation insight thresholds', () => {
  async function allocation(rows) {
    const u = await makeUser();
    await Holding.insertMany(
      rows.map(([ticker, assetType, value]) => ({
        user: u.user._id, ticker, assetType, quantity: 1, buyPrice: value, currentPrice: value, buyDate: '2026-01-15',
      }))
    );
    return (await request(app).get('/api/insights/allocation').set(u.auth)).body.insights.join('\n');
  }

  test('single holding: flagged at exactly 25%, not at 24%', async () => {
    const at25 = await allocation([['A', 'STOCK', 25], ['B', 'STOCK', 25], ['C', 'STOCK', 25], ['D', 'ETF', 25]]);
    expect(at25).toMatch(/makes up 25% of your portfolio/);
    const at24 = await allocation([['A', 'STOCK', 24], ['B', 'STOCK', 19], ['C', 'STOCK', 19], ['D', 'ETF', 19], ['E', 'ETF', 19]]);
    expect(at24).not.toMatch(/makes up/);
  });

  test('asset type: flagged at exactly 70%, not at 69%', async () => {
    const stocks = (each) => ['A', 'B', 'C', 'D'].map((t) => [t, 'STOCK', each]);
    const at70 = await allocation([...stocks(17.5), ['X', 'CRYPTO', 15], ['Y', 'CRYPTO', 15]]);
    expect(at70).toMatch(/70% of your portfolio is in stocks/);
    const at69 = await allocation([...stocks(17.25), ['X', 'CRYPTO', 15.5], ['Y', 'CRYPTO', 15.5]]);
    expect(at69).not.toMatch(/of your portfolio is in stocks/);
  });
});

describe('purchase evaluator', () => {
  // 300 daily closes ending on the buy date; `priceAt(t)` for t = 0 (oldest) .. 299 (buy day)
  const buyDate = new Date('2026-06-30T00:00:00Z');
  const series = (priceAt) => ({
    quotes: Array.from({ length: 300 }, (_, t) => ({
      date: new Date(buyDate.getTime() - (299 - t) * 86400000),
      close: priceAt(t),
    })),
  });
  const evaluate = (buyPrice) => evaluatePurchase({ ticker: 'TCS.NS', assetType: 'STOCK', buyPrice, buyDate, currentPrice: buyPrice });

  test('buying at the bottom of a falling year is a Good Entry', async () => {
    yahoo.chart.mockResolvedValue(series((t) => 200 - (t * 100) / 299));
    const r = await evaluate(100);
    expect(r.verdict).toBe('Good Entry');
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.signals.rangePositionPct).toBe(0);
  });

  test('buying at the top of a rising year is Overpaid, and score stays within +-100', async () => {
    yahoo.chart.mockResolvedValue(series((t) => 100 + (t * 100) / 299));
    const r = await evaluate(200);
    expect(r.verdict).toBe('Overpaid');
    expect(r.score).toBeLessThanOrEqual(-20);
    expect(Math.abs(r.score)).toBeLessThanOrEqual(100);
  });

  test('endpoint: 400 for non-market assets, 404 for another user\'s holding, 502 when Yahoo fails', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const mf = (await addHolding(a, { ticker: 'SOME FUND', assetType: 'MUTUAL_FUND' })).body;
    const stock = (await addHolding(a)).body;

    expect((await request(app).post(`/api/insights/evaluate/${mf._id}`).set(a.auth)).status).toBe(400);
    expect((await request(app).post(`/api/insights/evaluate/${stock._id}`).set(b.auth)).status).toBe(404);
    yahoo.chart.mockRejectedValue(new Error('yahoo down'));
    expect((await request(app).post(`/api/insights/evaluate/${stock._id}`).set(a.auth)).status).toBe(502);
  });
});

describe('manual price sync contract', () => {
  test('response carries market/mutualFunds {updated, failed} - the shape Dashboard.handleSync sums - and is rate limited', async () => {
    yahoo.quote.mockResolvedValue({ regularMarketPrice: 123 });
    const u = await makeUser();
    await addHolding(u);

    const res = await request(app).post('/api/prices/sync').set(u.auth);
    expect(res.status).toBe(200);
    expect(res.body.market).toEqual({ updated: 1, failed: 0 });
    expect(res.body.mutualFunds).toEqual({ updated: 0, failed: 0 });
    expect((await Holding.findOne()).currentPrice).toBe(123);

    expect((await request(app).post('/api/prices/sync').set(u.auth)).status).toBe(429);
  });
});

describe('deployment safety', () => {
  test('CORS: unlisted origin gets no allow header, the default local origin does', async () => {
    const evil = await request(app).get('/').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await request(app).get('/').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  test('every relative require matches on-disk casing (Linux hosts are case-sensitive)', () => {
    const root = path.join(__dirname, '..');
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        ['node_modules', '.git', 'tests'].includes(e.name) ? []
        : e.isDirectory() ? walk(path.join(d, e.name))
        : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
    const exact = (p) => {
      let cur = root;
      return path.relative(root, p).split(path.sep).every((seg) => {
        const ok = fs.readdirSync(cur).includes(seg);
        cur = path.join(cur, seg);
        return ok;
      });
    };
    const bad = [];
    for (const f of walk(root)) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const base = path.resolve(path.dirname(f), m[1]);
        const hit = [base, `${base}.js`, `${base}.json`].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
        if (!hit || !exact(hit)) bad.push(`${path.relative(root, f)} -> ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('portfolio history', () => {
  test('forward-fills: a crypto-only Saturday does not drop the stock out of the total', () => {
    const closes = new Map([
      ['TCS.NS', [['2026-09-25', 100], ['2026-09-28', 110]]],
      ['BTC-INR', [['2026-09-25', 10], ['2026-09-26', 11], ['2026-09-27', 12], ['2026-09-28', 13]]],
    ]);
    const items = [
      { symbol: 'TCS.NS', quantity: 1, buyKey: '2026-09-25' },
      { symbol: 'BTC-INR', quantity: 1, buyKey: '2026-09-25' },
    ];
    expect(buildHistorySeries(items, closes).map((p) => p.value)).toEqual([110, 111, 112, 123]);
  });
});
