const nodemailer = require('nodemailer');

let transport;
// Read lazily so a missing config only breaks signup, not server boot.
function getTransport() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS must be set (Gmail address + Google App Password)');
  }
  return (transport ||= nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } }));
}

// Render's free tier blocks outbound SMTP ports, so with BREVO_API_KEY set we
// send over HTTPS instead. Without it, local dev keeps using SMTP.
async function sendViaBrevo({ from, to, subject, text }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'WealthLens', email: from }, to: [{ email: to }], subject, textContent: text }),
    signal: AbortSignal.timeout(10000), // a stuck Brevo call must not hang the signup request
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Brevo API error ${res.status}: ${body.message || res.statusText}`);
  }
}

exports.sendVerificationCode = (to, code) => {
  const subject = 'Your WealthLens verification code';
  const text = `Your WealthLens verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't sign up, ignore this email.`;

  if (process.env.BREVO_API_KEY) {
    // SMTP_USER fallback keeps existing setups working without a new variable
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
    if (!from) throw new Error('EMAIL_FROM must be set (a sender verified in Brevo)');
    return sendViaBrevo({ from, to, subject, text });
  }
  return getTransport().sendMail({ from: `WealthLens <${process.env.SMTP_USER}>`, to, subject, text });
};
