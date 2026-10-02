const YahooFinance = require('yahoo-finance2').default;

// Shared singleton instance — yahoo-finance2 v3+ requires instantiating
// the class, and there's no benefit to creating multiple instances.
module.exports = new YahooFinance();
