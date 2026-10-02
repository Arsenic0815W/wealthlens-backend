const holidays2026 = require('../data/marketHolidays2026');
const { toISTDateString } = require('../utils/dates');

// Greetings are per-holiday, not blanket — some are solemn (Good Friday, Muharram)
// or civic (election day), where a cheerful greeting would be inappropriate.
const GREETINGS = {
  Holi: 'Happy Holi!',
  'Shri Ram Navami': 'Happy Ram Navami!',
  'Shri Mahavir Jayanti': 'Happy Mahavir Jayanti!',
  'Dr. Baba Saheb Ambedkar Jayanti': 'Happy Ambedkar Jayanti!',
  'Bakri Id': 'Eid Mubarak!',
  'Ganesh Chaturthi': 'Happy Ganesh Chaturthi!',
  Dussehra: 'Happy Dussehra!',
  'Diwali - Balipratipada': 'Happy Diwali!',
  'Guru Nanak Jayanti': 'Happy Gurpurab!',
  Christmas: 'Merry Christmas!',
  'Republic Day': 'Happy Republic Day!',
  'Maharashtra Day': 'Happy Maharashtra Day!',
};

// Years the holiday file actually covers. When the calendar rolls into a year
// that isn't listed, every holiday would silently count as a trading day, so
// warn (once per year) instead. Fix: append next year's NSE dates to the
// holidays file — this check picks them up automatically.
const coveredYears = new Set(holidays2026.map((h) => h.date.slice(0, 4)));
let warnedForYear = null;

function getMarketStatus(date = new Date()) {
  const istDateStr = toISTDateString(date);
  const year = istDateStr.slice(0, 4);
  if (!coveredYears.has(year) && warnedForYear !== year) {
    console.warn(
      `⚠ No NSE holiday list for ${year} in data/marketHolidays2026.js — holidays will be treated as trading days until you add them.`
    );
    warnedForYear = year;
  }
  const istWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
  }).format(date);
  const isWeekend = istWeekday === 'Saturday' || istWeekday === 'Sunday';

  const holiday = holidays2026.find((h) => h.date === istDateStr);

  if (holiday) {
    return {
      isOpen: false,
      reason: 'holiday',
      holidayName: holiday.name,
      greeting: GREETINGS[holiday.name] || null,
      date: istDateStr,
    };
  }

  if (isWeekend) {
    return {
      isOpen: false,
      reason: 'weekend',
      holidayName: null,
      greeting: null,
      date: istDateStr,
    };
  }

  return { isOpen: true, reason: null, holidayName: null, greeting: null, date: istDateStr };
}

module.exports = { getMarketStatus };
