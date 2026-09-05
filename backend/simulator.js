const { METHODS, REGIONS, AVG_TXN_AMOUNT_PAISE, TRANSACTIONS_PER_TICK_RANGE } = require('./config');

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function weightedPick(entries) {
  // entries: [[key, weight], ...]
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    if (r < w) return key;
    r -= w;
  }
  return entries[entries.length - 1][0];
}

const BACKGROUND_ERROR_CODES = ['insufficient_funds', 'user_cancelled', 'bank_declined'];

/**
 * Determine whether a transaction's dimensions are targeted by the current
 * incident's perturbation spec, and if so, what multiplier currently applies
 * (this changes over time as a recovery action progresses).
 */
function matchesPerturbation(spec, method, provider, region) {
  if (!spec) return false;
  if (spec.method && spec.method !== 'ALL' && spec.method !== method) return false;
  if (spec.provider && spec.provider !== provider) return false;
  if (spec.region && spec.region !== region) return false;
  return true;
}

/**
 * Simulate one tick (one "minute") of transaction volume across the whole
 * ecosystem, applying an optional active incident perturbation.
 * @param {object|null} activePerturbation - { method, provider, region, errorCode, currentMultiplier }
 */
function simulateTick(activePerturbation) {
  const totalTxns = Math.round(randomBetween(...TRANSACTIONS_PER_TICK_RANGE));
  const methodEntries = Object.entries(METHODS).map(([name, m]) => [name, m.weight]);

  const summary = {
    overall: { total: 0, success: 0 },
    byMethod: {},
    byMethodProvider: {},
    byRegion: {},
    errorCodes: {},
    totalAmountPaise: 0,
  };

  for (let i = 0; i < totalTxns; i++) {
    const method = weightedPick(methodEntries);
    const providerEntries = Object.entries(METHODS[method].providers).map(([name, p]) => [name, p.weight]);
    const provider = weightedPick(providerEntries);
    const region = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const providerConfig = METHODS[method].providers[provider];

    let effectiveRate = providerConfig.baseline;
    let affectedByIncident = false;
    if (matchesPerturbation(activePerturbation, method, provider, region)) {
      effectiveRate = effectiveRate * activePerturbation.currentMultiplier;
      affectedByIncident = true;
    }
    effectiveRate = Math.max(0, Math.min(1, effectiveRate));

    const amount = Math.round(randomBetween(50000, AVG_TXN_AMOUNT_PAISE * 2)); // ₹500 - ₹7,000
    const isSuccess = Math.random() < effectiveRate;

    // --- aggregate ---
    summary.overall.total++;
    summary.totalAmountPaise += amount;
    if (isSuccess) summary.overall.success++;

    summary.byMethod[method] = summary.byMethod[method] || { total: 0, success: 0 };
    summary.byMethod[method].total++;
    if (isSuccess) summary.byMethod[method].success++;

    const mpKey = `${method}::${provider}`;
    summary.byMethodProvider[mpKey] = summary.byMethodProvider[mpKey] || { total: 0, success: 0, method, provider };
    summary.byMethodProvider[mpKey].total++;
    if (isSuccess) summary.byMethodProvider[mpKey].success++;

    summary.byRegion[region] = summary.byRegion[region] || { total: 0, success: 0 };
    summary.byRegion[region].total++;
    if (isSuccess) summary.byRegion[region].success++;

    if (!isSuccess) {
      const errorCode = affectedByIncident
        ? activePerturbation.errorCode
        : BACKGROUND_ERROR_CODES[Math.floor(Math.random() * BACKGROUND_ERROR_CODES.length)];
      summary.errorCodes[errorCode] = (summary.errorCodes[errorCode] || 0) + 1;
    }
  }

  summary.overall.successRate = summary.overall.success / summary.overall.total;
  return summary;
}

module.exports = { simulateTick, matchesPerturbation };
