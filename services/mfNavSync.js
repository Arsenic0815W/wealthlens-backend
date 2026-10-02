const Holding = require('../models/Holding');

// Overridable so a URL change from AMFI is an env tweak, not a redeploy.
const AMFI_NAV_URL = process.env.AMFI_NAV_URL || 'https://www.amfiindia.com/spages/NAVAll.txt';

// Classic NAVAll.txt layout (6 fields; plan/option live inside the scheme name):
//   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
// Used only if the file has no "Scheme Code;..." header line to read from.
const CLASSIC_COLUMNS = { count: 6, name: 3, nav: 4, date: 5, plan: -1, option: -1 };

/**
 * Parses AMFI's semicolon-delimited NAV file. Column positions come from the
 * file's own header line, so both the classic 6-field layout and any layout
 * with separate Plan/Option columns work. Section lines (scheme types, AMC
 * names) have a different field count or a non-numeric code and are skipped.
 */
function parseAmfiNavText(text) {
  let cols = CLASSIC_COLUMNS;
  const rows = [];

  for (const raw of text.split('\n')) {
    const fields = raw.split(';').map((f) => f.trim());

    if (/^scheme code$/i.test(fields[0])) {
      const find = (name) => fields.findIndex((f) => f.toLowerCase() === name);
      cols = {
        count: fields.length,
        name: find('scheme name'),
        nav: find('net asset value'),
        date: find('date'),
        plan: find('plan'),
        option: find('option'),
      };
      continue;
    }

    if (fields.length !== cols.count || !/^\d+$/.test(fields[0])) continue;

    const nav = parseFloat(fields[cols.nav]);
    if (isNaN(nav)) continue; // AMFI lists some schemes with "N.A."

    rows.push({
      schemeCode: fields[0],
      schemeName: fields[cols.name],
      plan: cols.plan >= 0 ? fields[cols.plan] : '',
      option: cols.option >= 0 ? fields[cols.option] : '',
      nav,
      date: fields[cols.date],
    });
  }

  return rows;
}

async function fetchAmfiNavData() {
  const res = await fetch(AMFI_NAV_URL, {
    headers: {
      // AMFI blocks requests without a browser-like User-Agent
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch AMFI NAV file: ${res.status} ${res.statusText}`);
  }

  const rows = parseAmfiNavText(await res.text());

  // A 200 response that parses to nothing means the format changed — say so
  // loudly instead of reporting every fund as "no match".
  if (rows.length === 0) {
    throw new Error(
      `AMFI NAV file at ${AMFI_NAV_URL} parsed to 0 rows — the file format has probably changed. Check the first lines of the file and update parseAmfiNavText.`
    );
  }

  return rows;
}

/**
 * Finds the best matching AMFI scheme for a fund name typed/selected by the
 * user. Since our stored "ticker" for mutual funds is just a fund name (not
 * an official scheme code), this does a best-effort name match, preferring
 * Direct Plan + Growth option. Plan/option are read from their own columns
 * when the file has them, otherwise from the scheme name itself.
 */
function findBestMatch(fundName, navData) {
  const normalized = fundName.trim().toLowerCase();

  const candidates = navData.filter((row) => {
    const rowName = row.schemeName.toLowerCase();
    return rowName.includes(normalized) || normalized.includes(rowName);
  });

  if (candidates.length === 0) return null;

  const label = (row) => `${row.schemeName} ${row.plan} ${row.option}`.toLowerCase();

  return (
    candidates.find((row) => label(row).includes('direct') && label(row).includes('growth')) ||
    candidates.find((row) => label(row).includes('direct')) ||
    candidates[0]
  );
}

/**
 * Syncs currentPrice for MUTUAL_FUND holdings (all users by default, or
 * narrowed by `filter`). Fetches the AMFI file only once per run.
 */
async function syncMutualFundPrices(filter = {}) {
  const holdings = await Holding.find({ ...filter, assetType: 'MUTUAL_FUND' });

  if (holdings.length === 0) {
    console.log('No mutual fund holdings found.');
    return { updated: 0, failed: 0 };
  }

  let navData;
  try {
    navData = await fetchAmfiNavData();
  } catch (err) {
    console.error('Failed to fetch AMFI NAV data:', err.message);
    return { updated: 0, failed: holdings.length };
  }

  console.log(
    `Fetched ${navData.length} AMFI NAV rows. Matching ${holdings.length} fund holdings...`
  );

  let updated = 0;
  let failed = 0;
  const now = new Date();

  for (const h of holdings) {
    const match = findBestMatch(h.ticker, navData);

    if (!match) {
      console.error(`No AMFI match found for fund: "${h.ticker}"`);
      failed++;
      continue;
    }

    h.currentPrice = match.nav;
    h.priceUpdatedAt = now;
    try {
      await h.save();
      updated++;
    } catch (err) {
      failed++;
      console.error(`NAV update failed for holding ${h._id}:`, err.message);
    }
  }

  console.log(`Mutual fund sync complete: ${updated} updated, ${failed} failed.`);
  return { updated, failed };
}

module.exports = { parseAmfiNavText, fetchAmfiNavData, findBestMatch, syncMutualFundPrices };
