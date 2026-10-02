// Formats a Date as YYYY-MM-DD in IST, regardless of the server's timezone.
const toISTDateString = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

module.exports = { toISTDateString };
