/**
 * Evaluation harness — measures how often the root-cause classifier correctly
 * identifies the injected incident type, purely from observable evidence
 * (the classifier never sees which scenario was actually injected).
 *
 * Run with: node evaluate.js
 */
const { INCIDENT_SCENARIOS } = require('./config');
const { simulateTick } = require('./simulator');
const { investigate, aggregateWindow } = require('./investigate');

const TRIALS_PER_SCENARIO = 50;
const TICKS_PER_TRIAL = 6; // matches ROLLING_WINDOW_TICKS * 2 used in production

function runTrial(scenarioKey) {
  const scenario = INCIDENT_SCENARIOS[scenarioKey];
  const perturbation = {
    method: scenario.apply.method,
    provider: scenario.apply.provider,
    region: scenario.apply.region,
    errorCode: scenario.apply.errorCode,
    currentMultiplier: scenario.apply.successMultiplier,
  };
  const ticks = [];
  for (let i = 0; i < TICKS_PER_TRIAL; i++) ticks.push(simulateTick(perturbation));

  const windowAgg = aggregateWindow(ticks.slice(-3));
  const priorAgg = aggregateWindow(ticks.slice(-6, -3));
  return investigate(windowAgg, priorAgg);
}

function runBenchmark() {
  console.log(`\nRoot-cause classification benchmark — ${TRIALS_PER_SCENARIO} trials per scenario\n`);
  console.log('Scenario'.padEnd(20), 'Accuracy'.padEnd(12), 'Avg Confidence (correct)', 'Avg Confidence (incorrect)');
  console.log('-'.repeat(80));

  let totalCorrect = 0;
  let totalTrials = 0;

  for (const scenarioKey of Object.keys(INCIDENT_SCENARIOS)) {
    let correct = 0;
    const correctConfidences = [];
    const incorrectConfidences = [];

    for (let i = 0; i < TRIALS_PER_SCENARIO; i++) {
      const diagnosis = runTrial(scenarioKey);
      if (diagnosis.category === scenarioKey) {
        correct++;
        correctConfidences.push(diagnosis.confidence);
      } else {
        incorrectConfidences.push(diagnosis.confidence);
      }
    }

    totalCorrect += correct;
    totalTrials += TRIALS_PER_SCENARIO;

    const accuracy = ((correct / TRIALS_PER_SCENARIO) * 100).toFixed(1);
    const avgCorrectConf = correctConfidences.length
      ? (correctConfidences.reduce((a, b) => a + b, 0) / correctConfidences.length).toFixed(1)
      : 'n/a';
    const avgIncorrectConf = incorrectConfidences.length
      ? (incorrectConfidences.reduce((a, b) => a + b, 0) / incorrectConfidences.length).toFixed(1)
      : 'n/a';

    console.log(scenarioKey.padEnd(20), `${accuracy}%`.padEnd(12), avgCorrectConf.toString().padEnd(24), avgIncorrectConf);
  }

  console.log('-'.repeat(80));
  console.log(`Overall accuracy: ${((totalCorrect / totalTrials) * 100).toFixed(1)}% (${totalCorrect}/${totalTrials} trials)\n`);
}

runBenchmark();
