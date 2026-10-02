// Wraps async route handlers so errors are forwarded to Express's error
// middleware instead of requiring try/catch in every controller.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
