/**
 * Fallback classifier for user-typed issue descriptions when Gemini is not
 * configured (or fails). Deliberately simple and honest about being simple —
 * this is a keyword match, not real evidence-based reasoning, and it says so
 * in the evidence it returns.
 */
const KEYWORD_MAP = [
  { category: 'bank_degradation', keywords: ['upi', 'bhim', 'npci', 'bank is down', 'bank timeout', 'timing out', 'timeout', 'bank declined', 'bank decline'] },
  { category: 'card_processor', keywords: ['card', 'visa', 'mastercard', 'rupay', 'processor', 'gateway declin', 'credit card', 'debit card'] },
  { category: 'merchant_infra', keywords: ['checkout', 'website', 'my app', 'my site', 'all payment', 'every payment', 'all methods', 'integration', 'server error', 'site is down', 'site down', 'app crash', 'app is down'] },
  { category: 'regional_network', keywords: ['region', 'city', 'location', 'network issue', 'only in', 'north india', 'south india', 'east india', 'west india', 'state of', 'network'] },
];

function heuristicClassify(text) {
  const lower = (text || '').toLowerCase();
  for (const { category, keywords } of KEYWORD_MAP) {
    const matched = keywords.find((k) => lower.includes(k));
    if (matched) {
      return {
        category,
        targetLabel: 'user-reported',
        confidence: 55,
        evidence: [`Your description mentions "${matched}", which most closely matches a ${category.replace(/_/g, ' ')} pattern among known categories. (Gemini is not configured, so this used a simple keyword match rather than a full reading of your description — add a Gemini API key for a richer interpretation.)`],
      };
    }
  }
  return {
    category: 'unclassified',
    targetLabel: null,
    confidence: 20,
    evidence: ['Could not confidently match your description to a known pattern using simple keyword matching. Configure a Gemini API key for a richer interpretation of free-form reports.'],
  };
}

module.exports = { heuristicClassify };
