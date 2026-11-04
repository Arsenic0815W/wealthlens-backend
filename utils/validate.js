// Small shared input checks. Request bodies are attacker-controlled JSON, so a
// field that "should" be a string may arrive as a number, array or object.

const isStr = (v) => typeof v === 'string';

const PASSWORD_MIN = 8;
// bcrypt only looks at the first 72 BYTES; longer passwords would be silently truncated.
const PASSWORD_MAX_BYTES = 72;

// Returns an error message, or null when the password is acceptable.
function passwordProblem(password) {
  if (!isStr(password)) return 'Password must be text';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Password is too long (max ${PASSWORD_MAX_BYTES} characters)`;
  }
  return null;
}

const NAME_MAX = 100;
// Returns an error message, or null when the display name is acceptable.
function nameProblem(name) {
  if (!isStr(name) || !name.trim()) return 'Name is required';
  if (name.trim().length > NAME_MAX) return `Name must be at most ${NAME_MAX} characters`;
  return null;
}

// Finite number check for numeric form fields that may arrive as strings.
const isFiniteNumber = (v) => v !== '' && v !== null && typeof v !== 'boolean' && Number.isFinite(Number(v));

module.exports = { isStr, passwordProblem, nameProblem, isFiniteNumber, PASSWORD_MIN, NAME_MAX };
