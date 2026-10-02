const { runFullSync } = require('../services/dailySync');
const asyncHandler = require('../utils/asyncHandler');

const COOLDOWN_MS = 60 * 1000;
// pönytail: in-memory per-user cooldown, resets on restart and isn't shared
// across instances — upgrade path: store lastManualSyncAt on the User doc.
const lastSyncByUser = new Map();

// POST /api/prices/sync — refreshes only the requesting user's holdings.
exports.triggerSync = asyncHandler(async (req, res) => {
  const key = String(req.user._id);
  const waitMs = COOLDOWN_MS - (Date.now() - (lastSyncByUser.get(key) || 0));
  if (waitMs > 0) {
    return res
      .status(429)
      .json({ error: `Prices were just synced — try again in ${Math.ceil(waitMs / 1000)}s.` });
  }
  lastSyncByUser.set(key, Date.now());

  const result = await runFullSync({ userId: req.user._id });
  res.json({ message: 'Price sync complete', ...result });
});
