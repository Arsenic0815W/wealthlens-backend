const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
      select: false,
    },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, select: false }, // AES-256-GCM encrypted
    pendingTwoFactorSecret: { type: String, select: false },
    twoFactorBackupCodes: { type: [String], select: false }, // bcrypt hashes
    twoFactorLastUsedStep: { type: Number, select: false }, // replay protection
  },
  { timestamps: true }
);

userSchema.pre('save', async function () {
  if (!this.isModified('password') || this.$locals.passwordHashed) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
