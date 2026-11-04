// Security hardening checks. No database needed: every request here is answered
// (or rejected) before any query runs, and auth lookups are stubbed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-suite-0123456789';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../server');
const User = require('../models/user');
const { generateToken } = require('../utils/jwt');

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
});

describe('security headers', () => {
  test('helmet headers are set and X-Powered-By is gone', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('JWT hardening', () => {
  test('an unsigned alg=none token is rejected', async () => {
    const id = new mongoose.Types.ObjectId();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id })}.`;
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${none}`);
    expect(res.status).toBe(401);
  });

  test('a token signed with a different HMAC algorithm is rejected', async () => {
    const id = new mongoose.Types.ObjectId();
    const hs512 = jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${hs512}`);
    expect(res.status).toBe(401);
  });
});

describe('input type validation (no 500s from odd JSON)', () => {
  test('login rejects non-string email/password with 400', async () => {
    for (const body of [{ email: { $gt: '' }, password: 'x' }, { email: 'a@b.co', password: ['x'] }, { email: 1, password: 2 }]) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(400);
    }
  });

  test('signup enforces 8+ characters, the 72-byte bcrypt limit and text-only names', async () => {
    const cases = [
      { name: 'A', email: 'a@test.com', password: 'short7!' },
      { name: 'A', email: 'a@test.com', password: 'x'.repeat(73) },
      { name: 'A', email: 'a@test.com', password: ['secret123'] },
      { name: { first: 'A' }, email: 'a@test.com', password: 'secret123' },
      { name: 'A'.repeat(101), email: 'a@test.com', password: 'secret123' },
    ];
    for (const body of cases) {
      const res = await request(app).post('/api/auth/signup').send(body);
      expect(res.status).toBe(400);
    }
  });

  test('profile update validates name and email types', async () => {
    const id = new mongoose.Types.ObjectId();
    jest.spyOn(User, 'findById').mockResolvedValue({ _id: id, email: 'me@test.com' });
    const token = generateToken(id);
    for (const body of [{ email: ['x@y.com'] }, { email: 'not-an-email' }, { name: '' }, { name: { $set: 1 } }]) {
      const res = await request(app).put('/api/auth/me').set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
    }
  });

  test('holdings reject non-numeric, infinite and oversized values before touching the DB', async () => {
    const id = new mongoose.Types.ObjectId();
    jest.spyOn(User, 'findById').mockResolvedValue({ _id: id });
    const token = generateToken(id);
    const base = { ticker: 'TCS.NS', assetType: 'STOCK', quantity: 1, buyPrice: 100, buyDate: '2024-01-02' };
    const bad = [
      { ...base, quantity: 'Infinity' },
      { ...base, buyPrice: 'abc' },
      { ...base, ticker: ['TCS'] },
      { ...base, ticker: 'X'.repeat(41) },
      { ...base, note: { evil: true } },
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/holdings').set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
    }
    const upd = await request(app)
      .put(`/api/holdings/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ buyPrice: 'NaN' });
    expect(upd.status).toBe(400);
  });

  test('oversized JSON bodies are refused', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
  });
});

describe('rate limiting', () => {
  test('login is limited per IP: 30 tries per 15 minutes, then 429', async () => {
    process.env.ENABLE_RATE_LIMIT_IN_TESTS = '1';
    const statuses = [];
    // Invalid bodies are rejected with 400 before any DB access, but still count.
    for (let i = 0; i < 31; i++) {
      const res = await request(app).post('/api/auth/login').send({ email: 1, password: 2 });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
