const { AVG_TXN_AMOUNT_PAISE, INCIDENT_SCENARIOS } = require('./config');
const { overallBaseline } = require('./investigate');

/**
 * Quantify revenue exposure for the current window, and split it into
 * "gross exposure" (all lost transaction value) vs a hedged "recoverable"
 * estimate — never claim the full gross figure is recoverable, since some
 * customers retry or switch methods on their own regardless of any action.
 */
function calculateRevenueRisk(windowAgg, category) {
  const expectedRate = overallBaseline();
  const expectedSuccesses = windowAgg.overall.total * expectedRate;
  const actualSuccesses = windowAgg.overall.success;
  const lostTransactions = Math.max(0, Math.round(expectedSuccesses - actualSuccesses));

  const avgAmountPaise = windowAgg.overall.total
    ? windowAgg.totalAmountPaise / windowAgg.overall.total
    : AVG_TXN_AMOUNT_PAISE;

  const grossExposurePaise = Math.round(lostTransactions * avgAmountPaise);

  const scenario = INCIDENT_SCENARIOS[category];
  const recoveryProbability = scenario ? scenario.recoveryProbability : 0.3; // conservative default for unclassified

  const recoverableEstimatePaise = Math.round(grossExposurePaise * recoveryProbability);

  return {
    lostTransactions,
    avgAmountPaise: Math.round(avgAmountPaise),
    grossExposurePaise,
    recoveryProbability,
    recoverableEstimatePaise,
  };
}

module.exports = { calculateRevenueRisk };
