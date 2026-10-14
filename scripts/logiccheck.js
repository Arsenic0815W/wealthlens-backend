// Offline check for the business rules that sit on top of the database and Yahoo Finance.
// Run: node scripts/logiccheck.js   (no DB or network needed: Mongoose model methods and
// the Yahoo client are replaced with in-memory fakes before the code under test runs.)
const assert = require('assert');
process.env.JWT_SECRET = 'logiccheck-secret';

const yahoo = require('../utils/yahooFinance');
const Holding = require('../models/Holding');
const { getAllocationInsights } = require('../services/allocationInsights');
const { getMarketStatus } = require('../services/marketStatus');
const { validateBuyPrice } = require('../services/priceSync');
const { evaluatePurchase } = require('../services/purchaseEvaluator');
const holdingController = require('../controllers/holdingController');

const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400000);
const fakeRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const run = async (handler, req) => {
  const res = fakeRes();
  await handler(req, res, (e) => { throw e; });
  return res;
};
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

(async () => {
  // ---- allocation insights: the 25% / 70% thresholds ----
  const mk = (ticker, assetType, quantity, price) => ({ ticker, assetType, quantity, buyPrice: price, currentPrice: price });
  const alloc = async (rows) => { Holding.find = async () => rows; return getAllocationInsights('u1'); };
  let r = await alloc([mk('A.NS', 'STOCK', 1, 24), mk('B.NS', 'STOCK', 1, 26), mk('C.NS', 'STOCK', 1, 25), mk('D', 'GOLD', 1, 25)]);
  ok(r.insights.some((t) => t.includes('large share')), '26% holding must be flagged');
  r = await alloc([mk('A.NS', 'STOCK', 1, 24), mk('B.NS', 'STOCK', 1, 24), mk('C.NS', 'STOCK', 1, 24), mk('D', 'GOLD', 1, 28)]);
  ok(r.insights.some((t) => t.includes('large share')), 'exactly >=25% flagged (28%)');
  r = await alloc([mk('A.NS', 'STOCK', 1, 20), mk('B.NS', 'STOCK', 1, 20), mk('C', 'GOLD', 1, 20), mk('D', 'CRYPTO', 1, 20), mk('E', 'BOND', 1, 20)]);
  ok(!r.insights.some((t) => t.includes('large share')) && r.insights.some((t) => t.includes('reasonably spread')), '20% holdings: no warning, spread message');
  r = await alloc([mk('A.NS', 'STOCK', 1, 8), mk('B.NS', 'STOCK', 1, 8), mk('C.NS', 'STOCK', 1, 8), mk('D', 'GOLD', 1, 6)]);
  ok(r.insights.some((t) => t.includes('80% of your portfolio is in stocks')), '80% in one asset type flagged');
  r = await alloc([mk('A.NS', 'STOCK', 2, 100)]);
  ok(r.insights.some((t) => t.includes('entire portfolio')), 'single asset type message');
  r = await alloc([{ ticker: 'X', assetType: 'BOND', quantity: 2, buyPrice: 50, currentPrice: null }]);
  ok(r.totalValue === 100, 'unsynced holding falls back to buy price');
  r = await alloc([]);
  ok(r.totalValue === 0 && r.byAssetType.length === 0, 'empty portfolio');

  // ---- market status: weekend, listed holiday, ordinary weekday (all IST) ----
  ok(getMarketStatus(new Date('2026-10-10T06:00:00Z')).reason === 'weekend', 'Saturday is weekend');
  const hol = getMarketStatus(new Date('2026-03-03T06:00:00Z'));
  ok(!hol.isOpen && hol.reason === 'holiday' && hol.holidayName === 'Holi' && hol.greeting === 'Happy Holi!', 'Holi 2026 is a holiday with greeting');
  ok(getMarketStatus(new Date('2026-10-13T06:00:00Z')).isOpen === true, 'Tuesday 13 Oct 2026 is open');
  ok(getMarketStatus(new Date('2026-10-09T19:00:00Z')).date === '2026-10-10', 'UTC evening is the next IST date');

  // ---- buy price validation: 10% tolerance, fail-open, unsupported types ----
  const closeAt = (c) => async () => ({ quotes: [{ date: day(10), close: c }] });
  yahoo.chart = closeAt(100);
  ok((await validateBuyPrice('TCS.NS', 'STOCK', 110, day(10))).valid === true, '10% off accepted');
  const bad = await validateBuyPrice('TCS.NS', 'STOCK', 111, day(10));
  ok(bad.valid === false && bad.historicalPrice === 100, '11% off flagged with historical price');
  ok((await validateBuyPrice('X', 'BOND', 5000, day(10))).valid === true, 'BOND is not checked');
  ok((await validateBuyPrice('SGB', 'GOLD', 5000, day(10))).valid === true, 'non-exchange gold is not checked');
  yahoo.chart = async () => { throw new Error('network down'); };
  ok((await validateBuyPrice('TCS.NS', 'STOCK', 999, day(10))).valid === true, 'provider failure fails open');
  yahoo.chart = async () => ({ quotes: [] });
  ok((await validateBuyPrice('TCS.NS', 'STOCK', 999, day(10))).valid === true, 'no data fails open');

  // ---- purchase evaluator: score, verdict and as-of-buy-date signals ----
  const series = (f, len = 420) => Array.from({ length: len }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000), close: f(i) }));
  yahoo.chart = async () => ({ quotes: series(() => 100) });
  let e = await evaluatePurchase({ ticker: 'T.NS', assetType: 'STOCK', buyPrice: 100, buyDate: day(400), currentPrice: 120 });
  ok(e.verdict === 'Fair Entry' && e.signals.ma200AtBuy === 100 && e.unrealizedPnlPct === 20, 'flat prices: Fair Entry, MA200 100, +20%');
  yahoo.chart = async () => ({ quotes: series((i) => 100 + i * 0.5) });
  e = await evaluatePurchase({ ticker: 'T.NS', assetType: 'STOCK', buyPrice: 100, buyDate: new Date(Date.UTC(2024, 0, 1) + 380 * 86400000), currentPrice: 100 });
  ok(e.verdict === 'Good Entry' && e.score >= 20, 'buying far below a rising trend is a Good Entry');
  e = await evaluatePurchase({ ticker: 'T.NS', assetType: 'STOCK', buyPrice: 330, buyDate: new Date(Date.UTC(2024, 0, 1) + 380 * 86400000), currentPrice: 330 });
  ok(e.verdict === 'Overpaid' && e.score <= -20, 'buying far above the trend is Overpaid');
  yahoo.chart = async () => ({ quotes: [] });
  await assert.rejects(evaluatePurchase({ ticker: 'T.NS', assetType: 'STOCK', buyPrice: 1, buyDate: day(5), currentPrice: 1 }), /No historical data/); n++;

  // ---- holding controller: ownership is taken from the token, never the body ----
  let created;
  Holding.create = async (doc) => ((created = doc), { ...doc, _id: 'new' });
  yahoo.chart = closeAt(100);
  const me = { _id: 'user-A' };
  let res = await run(holdingController.create, { user: me, body: { user: 'user-B', ticker: 'tcs', assetType: 'STOCK', quantity: 2, buyPrice: 100, buyDate: day(10).toISOString() } });
  ok(res.code === 201 && created.user === 'user-A', 'owner comes from req.user, not the body');
  ok(created.ticker === 'TCS.NS', 'raw stock symbol gets the .NS suffix');
  await run(holdingController.create, { user: me, body: { ticker: 'SGB', assetType: 'GOLD', quantity: 1, buyPrice: 6000, buyDate: day(10).toISOString() } });
  ok(created.ticker === 'SGB', 'non-exchange gold keeps its name unsuffixed');
  res = await run(holdingController.create, { user: me, body: { ticker: 'TCS', assetType: 'STOCK', quantity: 2, buyPrice: 500, buyDate: day(10).toISOString() } });
  ok(res.code === 400 && res.body.priceMismatch === true, 'mismatched price returns 400 with priceMismatch');
  res = await run(holdingController.create, { user: me, body: { ticker: 'TCS', assetType: 'STOCK', quantity: 2, buyPrice: 500, buyDate: day(10).toISOString(), confirmPrice: true } });
  ok(res.code === 201, 'confirmPrice lets the user add anyway');
  res = await run(holdingController.create, { user: me, body: { ticker: 'TCS', assetType: 'SHARE', quantity: 2, buyPrice: 100, buyDate: day(10).toISOString() } });
  ok(res.code === 400, 'unknown asset type rejected');
  res = await run(holdingController.create, { user: me, body: { ticker: 'TCS', assetType: 'STOCK', quantity: -1, buyPrice: 100, buyDate: day(10).toISOString() } });
  ok(res.code === 400, 'negative quantity rejected');
  let seen;
  Holding.findOne = async (q) => ((seen = q), null);
  Holding.findOneAndDelete = async (q) => ((seen = q), null);
  res = await run(holdingController.getOne, { user: me, params: { id: 'h1' }, body: {} });
  ok(res.code === 404 && seen.user === 'user-A' && seen._id === 'h1', 'read filters by id AND owner');
  res = await run(holdingController.update, { user: me, params: { id: 'h1' }, body: { quantity: 5 } });
  ok(res.code === 404 && seen.user === 'user-A', 'update filters by owner');
  res = await run(holdingController.remove, { user: me, params: { id: 'h1' } });
  ok(res.code === 404 && seen.user === 'user-A', 'delete filters by owner');

  console.log(`logiccheck passed (${n} checks)`);
})().catch((err) => { console.error(err); process.exit(1); });
