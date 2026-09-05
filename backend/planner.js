const { INCIDENT_SCENARIOS } = require('./config');

const LOW_CONFIDENCE_THRESHOLD = 60;
const HIGH_CONFIDENCE_THRESHOLD = 85;

/**
 * Decide what to do about a diagnosed incident. Autonomy depends on BOTH
 * confidence and risk — a high-confidence diagnosis of a high-risk situation
 * still requires (or forbids) human involvement. This is the guardrail layer;
 * nothing here is decided by an LLM.
 */
function decidePlan({ category, confidence }) {
  if (category === 'no_incident') {
    return { autonomyTier: 'none', risk: 'none', recommendation: null };
  }

  if (category === 'unclassified' || confidence < LOW_CONFIDENCE_THRESHOLD) {
    return {
      autonomyTier: 'investigate_further',
      risk: 'unknown',
      recommendation: 'Confidence is too low to recommend an automated action. Flagging for manual analyst investigation rather than guessing.',
      scenarioKey: category,
    };
  }

  const scenario = INCIDENT_SCENARIOS[category];
  if (!scenario) {
    return {
      autonomyTier: 'investigate_further',
      risk: 'unknown',
      recommendation: 'Diagnosed a pattern outside known incident types. Escalating for manual review.',
      scenarioKey: category,
    };
  }

  if (scenario.autoApprovable === false) {
    return {
      autonomyTier: 'human_only',
      risk: scenario.risk,
      recommendation: scenario.recommendation,
      scenarioKey: category,
      note: 'This incident type is never automated, regardless of confidence — the pattern points to a merchant-side issue this system cannot safely fix on its own.',
    };
  }

  if (confidence >= HIGH_CONFIDENCE_THRESHOLD && scenario.risk === 'low') {
    return {
      autonomyTier: 'auto',
      risk: scenario.risk,
      recommendation: scenario.recommendation,
      scenarioKey: category,
      note: `Confidence (${confidence}%) exceeds the auto-action threshold and this is a low-risk action type — applying automatically.`,
    };
  }

  return {
    autonomyTier: 'approval_required',
    risk: scenario.risk,
    recommendation: scenario.recommendation,
    scenarioKey: category,
    note: `Risk tier is "${scenario.risk}" — even at ${confidence}% confidence, this requires a human to approve before acting.`,
  };
}

module.exports = { decidePlan, LOW_CONFIDENCE_THRESHOLD, HIGH_CONFIDENCE_THRESHOLD };
