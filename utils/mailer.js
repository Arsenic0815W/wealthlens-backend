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

exports.sendVerificationCode = (to, code) =>
  getTransport().sendMail({
    from: `WealthLens <${process.env.SMTP_USER}>`,
    to,
    subject: 'Your WealthLens verification code',
    text: `Your WealthLens verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't sign up, ignore this email.`,
  });
