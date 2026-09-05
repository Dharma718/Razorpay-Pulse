/**
 * Gemini is used for narrative generation AND for interpreting free-form,
 * user-typed issue descriptions (optionally with a screenshot). Even here,
 * Gemini only proposes a category + confidence + evidence — the SAME
 * deterministic guardrail rules in planner.js decide the actual action.
 * The "AI narrates/suggests, rules decide" principle holds for every
 * entry point into this system, not just the simulated scenarios.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const ENABLED = !!GEMINI_API_KEY;

const ALLOWED_CATEGORIES = ['bank_degradation', 'card_processor', 'merchant_infra', 'regional_network', 'unclassified'];

/**
 * Low-level call supporting arbitrary content parts (text and/or inline image
 * data), so it works for both simple text prompts and multimodal input.
 */
async function callGeminiParts(parts, { json = false } = {}) {
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts }],
    ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
  });

  // Google is mid-rollout on a new "AQ." API key format alongside the older
  // "AIzaSy" format, and different accounts/transports currently behave
  // inconsistently (Google's own AI Developers Forum has many open threads
  // on this, mid-2026). Try query-param auth first, then header auth.
  const attempts = [
    { url: `${baseUrl}?key=${GEMINI_API_KEY}`, headers: { 'Content-Type': 'application/json' } },
    { url: baseUrl, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY } },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { method: 'POST', headers: attempt.headers, body });
      if (res.ok) {
        const data = await res.json();
        return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      }
      const errText = await res.text();
      lastError = new Error(`Gemini API error ${res.status}: ${errText}`);
      if (!errText.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')) break;
      console.error('Gemini key rejected by this transport (ACCESS_TOKEN_TYPE_UNSUPPORTED) — trying the other auth method. Known Google-side inconsistency with newer "AQ." format keys, not a bug in this code.');
    } catch (err) {
      lastError = err;
      break;
    }
  }
  throw lastError;
}

async function callGemini(prompt) {
  return callGeminiParts([{ text: prompt }]);
}

async function generateNarrative(diagnosis) {
  if (!ENABLED) return null;
  try {
    const prompt = `You are an SRE writing a brief incident summary for a payments dashboard.

Diagnosis category: ${diagnosis.category}
Target: ${diagnosis.targetLabel || 'n/a'}
Confidence: ${diagnosis.confidence}%

Supporting evidence:
${diagnosis.evidence.map((e) => `- ${e}`).join('\n')}

Contradicting/other signals:
${(diagnosis.contradicting || []).map((e) => `- ${e}`).join('\n')}

Write 2-3 sentences, plain English, no jargon like "category" or "vector". Sound like a calm, competent engineer explaining what's happening, not a robot reading a log.`;
    return await callGemini(prompt);
  } catch (err) {
    console.error('Gemini narrative generation failed:', err.message);
    return null;
  }
}

async function generateCustomerNotice(diagnosis, plan) {
  if (!ENABLED) return null;
  try {
    const prompt = `Write a short (2 sentences), reassuring notice for customers affected by a payment issue in the "${diagnosis.targetLabel || 'affected'}" area.
Action being taken: ${plan.recommendation}
Do not use technical jargon. Be warm and specific about what they should do (e.g. try again shortly, or use another payment method).`;
    return await callGemini(prompt);
  } catch (err) {
    console.error('Gemini notice generation failed:', err.message);
    return null;
  }
}

/**
 * Interpret a free-form, user-typed issue description (optionally with a
 * screenshot) and propose a category. This NEVER decides the action —
 * planner.js's deterministic guardrails still gate what happens next,
 * exactly as they do for simulated scenarios.
 */
async function classifyFreeformIssue(text, imageBase64, imageMimeType) {
  if (!ENABLED) return null;
  try {
    const instructions = `A merchant has described a payment issue in their own words. Classify it.

Description: "${text || '(no text provided — rely on the attached image if present)'}"

Categories (pick exactly one):
- bank_degradation: a specific bank or UPI provider seems to be failing/timing out
- card_processor: card payments specifically seem to be failing
- merchant_infra: ALL or MOST payment methods are failing, sounds like a checkout/website/integration issue
- regional_network: failures seem concentrated in one geography/region/network
- unclassified: doesn't clearly match any of the above, or is too vague to tell

Respond ONLY with JSON, no markdown fences, in this exact shape:
{"category": "<one of the categories above>", "targetLabel": "<short label like a bank/processor/region name if mentioned or visible, else null>", "confidence": <integer 0-100, your genuine confidence>, "evidence": ["<1-3 short strings explaining your reasoning>"]}`;

    const parts = [{ text: instructions }];
    if (imageBase64) {
      parts.push({ inline_data: { mime_type: imageMimeType || 'image/png', data: imageBase64 } });
      parts[0].text += '\n\nAn image (likely a screenshot of the issue) is attached — factor in anything visible in it, such as error messages or payment method logos.';
    }

    const raw = await callGeminiParts(parts, { json: true });
    const cleaned = raw.replace(/^```json\s*|^```\s*|```\s*$/g, '').trim(); // defensive: strip markdown fences if the model adds them anyway
    const parsed = JSON.parse(cleaned);
    if (!ALLOWED_CATEGORIES.includes(parsed.category)) return null;

    return {
      category: parsed.category,
      targetLabel: parsed.targetLabel || null,
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
      evidence: Array.isArray(parsed.evidence) && parsed.evidence.length ? parsed.evidence : ['AI-generated interpretation of the description provided.'],
    };
  } catch (err) {
    console.error('Gemini freeform classification failed:', err.message);
    return null;
  }
}

module.exports = { generateNarrative, generateCustomerNotice, classifyFreeformIssue, ENABLED, GEMINI_MODEL };
