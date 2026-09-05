const test = require('node:test');
const assert = require('node:assert');
const { simulateTick } = require('./simulator');
const { investigate, aggregateWindow, overallBaseline } = require('./investigate');
const { calculateRevenueRisk } = require('./revenue');
const { decidePlan } = require('./planner');

function runTicks(perturbation, n) {
  const ticks = [];
  for (let i = 0; i < n; i++) ticks.push(simulateTick(perturbation));
  return ticks;
}

test('healthy traffic (no perturbation) does not trigger an incident', () => {
  const ticks = runTicks(null, 6);
  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  const diagnosis = investigate(windowAgg, priorAgg);
  assert.strictEqual(diagnosis.category, 'no_incident');
});

test('a single-provider degradation (bank_degradation-style) is correctly isolated', () => {
  const perturbation = { method: 'upi', provider: 'Bank C', region: null, errorCode: 'timeout', currentMultiplier: 0.4 };
  const ticks = runTicks(perturbation, 6);
  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  const diagnosis = investigate(windowAgg, priorAgg);

  assert.strictEqual(diagnosis.category, 'bank_degradation');
  assert.strictEqual(diagnosis.targetLabel, 'Bank C');
  assert.ok(diagnosis.confidence > 50, `expected reasonable confidence, got ${diagnosis.confidence}`);
  assert.ok(diagnosis.evidence.length >= 2);
});

test('a card processor degradation is classified as card_processor, not bank_degradation', () => {
  const perturbation = { method: 'card', provider: 'Processor X', region: null, errorCode: 'gateway_error', currentMultiplier: 0.35 };
  const ticks = runTicks(perturbation, 6);
  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  const diagnosis = investigate(windowAgg, priorAgg);

  assert.strictEqual(diagnosis.category, 'card_processor');
  assert.strictEqual(diagnosis.targetLabel, 'Processor X');
});

test('a uniform drop across all methods is classified as merchant_infra', () => {
  const perturbation = { method: 'ALL', provider: null, region: null, errorCode: 'processing_error', currentMultiplier: 0.7 };
  const ticks = runTicks(perturbation, 6);
  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  const diagnosis = investigate(windowAgg, priorAgg);

  assert.strictEqual(diagnosis.category, 'merchant_infra');
});

test('a regional-only degradation is classified as regional_network', () => {
  const perturbation = { method: null, provider: null, region: 'South', errorCode: 'network_error', currentMultiplier: 0.55 };
  const ticks = runTicks(perturbation, 6);
  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  const diagnosis = investigate(windowAgg, priorAgg);

  assert.strictEqual(diagnosis.category, 'regional_network');
  assert.strictEqual(diagnosis.targetLabel, 'South');
});

test('revenue risk never claims more recoverable than gross exposure', () => {
  const perturbation = { method: 'upi', provider: 'Bank C', region: null, errorCode: 'timeout', currentMultiplier: 0.4 };
  const ticks = runTicks(perturbation, 3);
  const windowAgg = aggregateWindow(ticks);
  const risk = calculateRevenueRisk(windowAgg, 'bank_degradation');

  assert.ok(risk.recoverableEstimatePaise <= risk.grossExposurePaise);
  assert.ok(risk.recoveryProbability > 0 && risk.recoveryProbability <= 1);
});

test('planner: merchant_infra is always human_only regardless of confidence', () => {
  const plan = decidePlan({ category: 'merchant_infra', confidence: 95 });
  assert.strictEqual(plan.autonomyTier, 'human_only');
});

test('planner: low confidence never leads to an automated or approval-based action', () => {
  const plan = decidePlan({ category: 'bank_degradation', confidence: 40 });
  assert.strictEqual(plan.autonomyTier, 'investigate_further');
});

test('planner: high confidence + low risk allows full autonomy', () => {
  const plan = decidePlan({ category: 'regional_network', confidence: 90 });
  assert.strictEqual(plan.autonomyTier, 'auto');
});

test('planner: medium risk requires human approval even at high confidence', () => {
  const plan = decidePlan({ category: 'bank_degradation', confidence: 92 });
  assert.strictEqual(plan.autonomyTier, 'approval_required');
});

test('overallBaseline reflects a sensible blended value between 0 and 1', () => {
  const b = overallBaseline();
  assert.ok(b > 0.8 && b < 1);
});
