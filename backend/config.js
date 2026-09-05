/**
 * Central config for the simulated payment ecosystem.
 * These baselines represent "normal" operating targets per dimension —
 * comparable to SLOs a real payments ops team would track (similar in
 * spirit to NPCI's published UPI decline benchmarks).
 */

const METHODS = {
  upi: {
    baselineSuccessRate: 0.93,
    weight: 0.55, // share of total transaction volume
    providers: {
      'Bank A': { baseline: 0.94, weight: 0.3 },
      'Bank B': { baseline: 0.93, weight: 0.28 },
      'Bank C': { baseline: 0.92, weight: 0.24 },
      'Bank D': { baseline: 0.93, weight: 0.18 },
    },
  },
  card: {
    baselineSuccessRate: 0.95,
    weight: 0.25,
    providers: {
      'Processor X': { baseline: 0.96, weight: 0.6 },
      'Processor Y': { baseline: 0.94, weight: 0.4 },
    },
  },
  netbanking: {
    baselineSuccessRate: 0.90,
    weight: 0.12,
    providers: {
      'Bank A': { baseline: 0.91, weight: 0.5 },
      'Bank E': { baseline: 0.89, weight: 0.5 },
    },
  },
  wallet: {
    baselineSuccessRate: 0.91,
    weight: 0.08,
    providers: {
      'Wallet P': { baseline: 0.92, weight: 0.5 },
      'Wallet Q': { baseline: 0.90, weight: 0.5 },
    },
  },
};

const REGIONS = ['North', 'South', 'East', 'West'];

const AVG_TXN_AMOUNT_PAISE = 350000; // ₹3,500, matches the doc's worked example

// Ticks are simulated "minutes" of traffic
const TRANSACTIONS_PER_TICK_RANGE = [800, 1200];

// Anomaly detection thresholds
const ANOMALY_DROP_THRESHOLD = 0.08; // 8 percentage point drop vs baseline
const ANOMALY_CONSECUTIVE_TICKS = 2; // must persist for this many ticks
const ROLLING_WINDOW_TICKS = 3; // window used to compute "current" success rate

// Incident scenarios that can be injected — mirrors the doc's Incident A-D
const INCIDENT_SCENARIOS = {
  bank_degradation: {
    label: 'Bank C UPI timeout degradation',
    description: 'A single UPI banking partner starts timing out.',
    apply: { method: 'upi', provider: 'Bank C', successMultiplier: 0.46, errorCode: 'timeout' },
    recoveryProbability: 0.55,
    risk: 'medium',
    recommendation: 'Boost alternative payment method visibility (Cards, Netbanking) for customers whose UPI attempts are routing through Bank C.',
    autoApprovable: true,
  },
  merchant_infra: {
    label: 'Merchant-side checkout regression',
    description: 'All payment methods degrade simultaneously — points to the merchant\'s own integration, not a bank.',
    apply: { method: 'ALL', provider: null, successMultiplier: 0.72, errorCode: 'processing_error' },
    recoveryProbability: 0.20,
    risk: 'high',
    recommendation: 'This pattern does not match a bank/network issue — it affects every payment method equally. Escalate to engineering immediately; do not attempt automated payment-routing fixes.',
    autoApprovable: false,
  },
  regional_network: {
    label: 'Regional network disruption — South',
    description: 'One geographic region degrades across all methods; other regions stay normal.',
    apply: { region: 'South', successMultiplier: 0.6, errorCode: 'network_error' },
    recoveryProbability: 0.40,
    risk: 'low',
    recommendation: 'Notify affected-region customers of a temporary network issue and suggest retrying in a few minutes.',
    autoApprovable: true,
  },
  card_processor: {
    label: 'Card processor degradation — Processor X',
    description: 'A single card processor degrades while UPI/Netbanking stay normal.',
    apply: { method: 'card', provider: 'Processor X', successMultiplier: 0.35, errorCode: 'gateway_error' },
    recoveryProbability: 0.60,
    risk: 'medium',
    recommendation: 'Temporarily deprioritize Processor X as the default card route; promote UPI and Netbanking as primary suggestions.',
    autoApprovable: true,
  },
};

module.exports = {
  METHODS,
  REGIONS,
  AVG_TXN_AMOUNT_PAISE,
  TRANSACTIONS_PER_TICK_RANGE,
  ANOMALY_DROP_THRESHOLD,
  ANOMALY_CONSECUTIVE_TICKS,
  ROLLING_WINDOW_TICKS,
  INCIDENT_SCENARIOS,
};
