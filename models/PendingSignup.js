const mongoose = require('mongoose');

// A signup that hasn't finished both verification steps. The real User is only
// created on completion; MongoDB's TTL index deletes abandoned rows.
const pendingSignupSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: Date.now },
  emailVerified: { type: Boolean, default: false },
  totpSecret: String, // AES-256-GCM encrypted, set once the email is verified
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);
