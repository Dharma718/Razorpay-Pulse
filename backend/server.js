require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const { INCIDENT_SCENARIOS, ANOMALY_DROP_THRESHOLD, ANOMALY_CONSECUTIVE_TICKS, ROLLING_WINDOW_TICKS, METHODS, REGIONS } = require('./config');
const { simulateTick } = require('./simulator');
const { investigate, aggregateWindow, overallBaseline } = require('./investigate');
const { calculateRevenueRisk } = require('./revenue');
const { decidePlan, LOW_CONFIDENCE_THRESHOLD, HIGH_CONFIDENCE_THRESHOLD } = require('./planner');
const { loadMemory, findSimilar, recordOutcome, clearMemory, deleteEntry } = require('./memory');
const { generateNarrative, generateCustomerNotice, classifyFreeformIssue, ENABLED: GEMINI_ENABLED, GEMINI_MODEL } = require('./gemini');
const { heuristicClassify } = require('./freeform-heuristic');
const {
  isOwnerConfigured, loadOwnerCredentials, saveOwnerCredentials, verifyPassword,
  issueSessionCookie, clearSessionCookie, requireAuth,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;
const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '2500', 10);
const RECOVERY_STEP = 0.3; // fraction of the way back to baseline per tick once recovery starts
const MAX_REPORT_TEXT_LENGTH = 1000;
const MAX_IMAGE_BASE64_LENGTH = 6_000_000; // ~4.5MB decoded, generous for a screenshot

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '8mb' })); // raised for base64 screenshot uploads
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---- Auth routes (public — no session required) ----

app.get('/api/auth/status', (req, res) => {
  res.json({ ownerConfigured: isOwnerConfigured() });
});

app.post('/api/auth/setup', (req, res) => {
  if (isOwnerConfigured()) return res.status(409).json({ error: 'An account already exists — please sign in instead.' });
  const { name, email, password, confirmPassword } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please tell us what to call you.' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });

  const saved = saveOwnerCredentials(name.trim(), email.trim().toLowerCase(), password);
  issueSessionCookie(res, { email: saved.email, name: saved.name, role: 'owner' });
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const creds = loadOwnerCredentials();
  if (!creds || !email || !password || email.trim().toLowerCase() !== creds.email || !verifyPassword(password, creds.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  issueSessionCookie(res, { email: creds.email, name: creds.name, role: 'owner' });
  res.json({ ok: true });
});

app.post('/api/auth/demo-login', (req, res) => {
  issueSessionCookie(res, { email: 'demo@pulse.dev', name: 'Recruiter Demo', role: 'demo' });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

// ---- Everything below this line requires a valid session ----
app.use('/api', requireAuth);

// ---- live simulation state (in-memory; resets are explicit via /api/reset) ----
let tickHistory = [];
let injection = null; // { key, method, provider, region, errorCode, baseMultiplier, currentMultiplier, recoveryProgress, status }
let currentIncident = null;
let consecutiveAnomalyTicks = 0;
let memory = loadMemory();
let isProcessing = false;

function audit(incident, message) {
  incident.auditLog.push({ at: Date.now(), message });
}

/**
 * Shared resolution finalizer for BOTH simulated-scenario incidents (which
 * have a real recovering success rate) and freeform user-reported incidents
 * (which don't — there's no live simulated traffic tied to a typed report,
 * so we don't fabricate a recovery curve for those; healedRate is null).
 */
function finalizeResolution(incident, { healedRate, note }) {
  audit(incident, note);
  incident.successRateAfter = healedRate;
  incident.status = 'resolved';
  incident.outcome = 'recovered';
  incident.revenueProtectedPaise = incident.revenue ? incident.revenue.recoverableEstimatePaise : null;
  memory = recordOutcome(memory, incident);
}

function currentPerturbationForSimulator() {
  if (!injection) return null;
  return {
    method: injection.method,
    provider: injection.provider,
    region: injection.region,
    errorCode: injection.errorCode,
    currentMultiplier: injection.currentMultiplier,
  };
}

/**
 * Check overall, per-method, AND per-region deviations — a localized incident
 * (e.g. one UPI bank out of four) can be too diluted to show up in the
 * overall aggregate, so relying on overall alone would miss real incidents.
 */
function tickHasAnomaly(tick, baseline) {
  if (tick.overall.total >= 50 && baseline - tick.overall.successRate > ANOMALY_DROP_THRESHOLD) return true;

  for (const [method, cfg] of Object.entries(METHODS)) {
    const bucket = tick.byMethod[method];
    if (bucket && bucket.total >= 30) {
      const rate = bucket.success / bucket.total;
      if (cfg.baselineSuccessRate - rate > ANOMALY_DROP_THRESHOLD) return true;
    }
  }
  for (const region of REGIONS) {
    const bucket = tick.byRegion[region];
    if (bucket && bucket.total >= 30) {
      const rate = bucket.success / bucket.total;
      if (baseline - rate > ANOMALY_DROP_THRESHOLD) return true;
    }
  }
  return false;
}

async function processTick() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    // 1. advance recovery, if any is in progress
    if (injection && injection.status === 'recovering') {
      injection.recoveryProgress = Math.min(1, injection.recoveryProgress + RECOVERY_STEP);
      injection.currentMultiplier = injection.baseMultiplier + (1 - injection.baseMultiplier) * injection.recoveryProgress;
      if (injection.recoveryProgress >= 1) injection.currentMultiplier = 1;
    }

    // 2. simulate this tick's traffic
    const tick = simulateTick(currentPerturbationForSimulator());
    tickHistory.push(tick);
    if (tickHistory.length > 180) tickHistory.shift();

    // 3. check if a recovering incident has fully healed
    if (currentIncident && injection && injection.status === 'recovering' && injection.recoveryProgress >= 1) {
      const recentWindow = aggregateWindow(tickHistory.slice(-ROLLING_WINDOW_TICKS));
      const healedRate = recentWindow.overall.total ? recentWindow.overall.success / recentWindow.overall.total : 1;
      finalizeResolution(currentIncident, {
        healedRate,
        note: `Recovery action complete — recent success rate is back to ${(healedRate * 100).toFixed(1)}%, consistent with baseline.`,
      });
      injection = null;
      consecutiveAnomalyTicks = 0;
      // NOTE: currentIncident is intentionally NOT auto-cleared here — it stays
      // visible, showing "Resolved", until the operator clicks Dismiss.
    }

    // 4. anomaly detection + investigation — only when no incident is currently open/displayed
    if (!currentIncident) {
      const baseline = overallBaseline();
      if (tickHasAnomaly(tick, baseline)) {
        consecutiveAnomalyTicks += 1;
      } else {
        consecutiveAnomalyTicks = 0;
      }

      if (consecutiveAnomalyTicks >= ANOMALY_CONSECUTIVE_TICKS) {
        const windowAgg = aggregateWindow(tickHistory.slice(-ROLLING_WINDOW_TICKS));
        const priorAgg = aggregateWindow(tickHistory.slice(-ROLLING_WINDOW_TICKS * 2, -ROLLING_WINDOW_TICKS));
        const diagnosis = investigate(windowAgg, priorAgg);

        if (diagnosis.category !== 'no_incident') {
          const plan = decidePlan(diagnosis);
          const revenue = calculateRevenueRisk(windowAgg, diagnosis.category);
          const similar = findSimilar(memory, diagnosis.category);

          const incident = {
            id: 'inc_' + crypto.randomBytes(5).toString('hex'),
            category: diagnosis.category,
            targetLabel: diagnosis.targetLabel,
            confidence: diagnosis.confidence,
            evidence: diagnosis.evidence,
            contradicting: diagnosis.contradicting,
            plan,
            revenue,
            similar,
            source: 'scenario',
            successRateBefore: windowAgg.overall.total ? windowAgg.overall.success / windowAgg.overall.total : tick.overall.successRate,
            createdAt: Date.now(),
            auditLog: [],
            narrative: null,
            customerNotice: null,
            status: 'open',
            outcome: 'ongoing',
          };
          audit(incident, `Anomaly confirmed for ${ANOMALY_CONSECUTIVE_TICKS} consecutive ticks. Latest tick success rate ${(tick.overall.successRate * 100).toFixed(1)}% vs ${(baseline * 100).toFixed(1)}% overall baseline.`);
          audit(incident, `Diagnosis: ${diagnosis.category} (${diagnosis.confidence}% confidence). Target: ${diagnosis.targetLabel || 'n/a'}.`);
          audit(incident, `Revenue exposure: ₹${(revenue.grossExposurePaise / 100).toLocaleString('en-IN')} gross, ₹${(revenue.recoverableEstimatePaise / 100).toLocaleString('en-IN')} estimated recoverable.`);
          if (similar) {
            const protectedText = (similar.revenueProtectedPaise != null && !Number.isNaN(similar.revenueProtectedPaise))
              ? `₹${(similar.revenueProtectedPaise / 100).toLocaleString('en-IN')}`
              : 'an unrecorded amount';
            audit(incident, `Similar past incident found (${similar.id}): recovered from ${(similar.successRateBefore * 100).toFixed(1)}% to ${(similar.successRateAfter * 100).toFixed(1)}%, protecting ${protectedText}.`);
          }

          if (injection) injection.currentMultiplier = injection.baseMultiplier; // ensure not mid-recovery already

          if (plan.autonomyTier === 'human_only') {
            incident.status = 'escalated';
            audit(incident, `Escalated to human — ${plan.note}`);
          } else if (plan.autonomyTier === 'auto') {
            incident.status = 'recovering';
            if (injection) { injection.status = 'recovering'; injection.recoveryProgress = 0; }
            audit(incident, `Auto-applying action — ${plan.note}`);
            generateCustomerNotice(diagnosis, plan).then((notice) => { if (notice) incident.customerNotice = notice; });
          } else if (plan.autonomyTier === 'investigate_further') {
            audit(incident, `Confidence too low to act — flagged for manual investigation. ${plan.recommendation}`);
          } else {
            audit(incident, `Awaiting human approval — ${plan.note || 'standard approval policy for this risk tier.'}`);
          }

          currentIncident = incident;
          generateNarrative(diagnosis).then((narrative) => { if (narrative) incident.narrative = narrative; });
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}

setInterval(processTick, TICK_INTERVAL_MS);

// ---- API ----

app.get('/api/state', (req, res) => {
  const latestTick = tickHistory[tickHistory.length - 1] || null;
  const sparkline = tickHistory.slice(-40).map((t) => Math.round(t.overall.successRate * 1000) / 10);
  const methodHealth = latestTick
    ? Object.entries(latestTick.byMethod).map(([method, v]) => ({ method, rate: v.total ? v.success / v.total : 1 }))
    : [];

  let health = 'healthy';
  if (currentIncident && currentIncident.status !== 'resolved') {
    health = currentIncident.plan?.risk === 'high' || currentIncident.status === 'escalated' ? 'critical' : 'degraded';
  }

  res.json({
    health,
    overallSuccessRate: latestTick ? latestTick.overall.successRate : null,
    baseline: overallBaseline(),
    sparkline,
    methodHealth,
    currentIncident,
    injectionActive: !!injection || !!currentIncident,
    geminiEnabled: GEMINI_ENABLED,
  });
});

app.get('/api/incidents', (req, res) => {
  res.json(memory);
});

app.post('/api/memory/clear', (req, res) => {
  memory = clearMemory();
  res.json({ ok: true });
});

app.delete('/api/memory/:id', (req, res) => {
  const exists = memory.some((m) => m.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'That history entry no longer exists.' });
  memory = deleteEntry(memory, req.params.id);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({
    anomalyDropThreshold: ANOMALY_DROP_THRESHOLD,
    anomalyConsecutiveTicks: ANOMALY_CONSECUTIVE_TICKS,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    scenarios: Object.entries(INCIDENT_SCENARIOS).map(([key, s]) => ({ key, label: s.label, risk: s.risk, autoApprovable: s.autoApprovable })),
    geminiEnabled: GEMINI_ENABLED,
    geminiModel: GEMINI_ENABLED ? GEMINI_MODEL : null,
    tickIntervalMs: TICK_INTERVAL_MS,
  });
});

app.post('/api/incidents/inject', (req, res) => {
  const { scenarioKey } = req.body || {};
  const scenario = INCIDENT_SCENARIOS[scenarioKey];
  if (!scenario) return res.status(400).json({ error: 'Unknown scenario key' });
  if (injection || currentIncident) return res.status(409).json({ error: 'An incident is already active (or still being displayed) — dismiss it or reset first.' });

  injection = {
    key: scenarioKey,
    method: scenario.apply.method,
    provider: scenario.apply.provider,
    region: scenario.apply.region,
    errorCode: scenario.apply.errorCode,
    baseMultiplier: scenario.apply.successMultiplier,
    currentMultiplier: scenario.apply.successMultiplier,
    recoveryProgress: 0,
    status: 'active',
  };
  consecutiveAnomalyTicks = 0;
  res.json({ ok: true, injected: scenarioKey });
});

/**
 * Free-form issue reporting: a user describes their own problem (optionally
 * with a screenshot) instead of picking from the fixed scenario list. Gemini
 * (or a keyword fallback if Gemini isn't configured) proposes a category —
 * the SAME deterministic guardrails in planner.js then decide the action,
 * exactly as they do for simulated scenarios. No revenue figure is shown for
 * these, since there's no live simulated traffic behind a typed report to
 * measure exposure from — fabricating one would be dishonest.
 */
app.post('/api/incidents/freeform', async (req, res) => {
  try {
    if (injection || currentIncident) return res.status(409).json({ error: 'An incident is already active (or still being displayed) — dismiss it or reset first.' });

    const { text, imageBase64, imageMimeType } = req.body || {};
    const cleanText = typeof text === 'string' ? text.slice(0, MAX_REPORT_TEXT_LENGTH) : '';
    if (!cleanText && !imageBase64) return res.status(400).json({ error: 'Please describe the issue or attach an image.' });
    if (imageBase64 && imageBase64.length > MAX_IMAGE_BASE64_LENGTH) return res.status(400).json({ error: 'Image is too large — please use a smaller screenshot (under ~4MB).' });

    let diagnosis = await classifyFreeformIssue(cleanText, imageBase64, imageMimeType);
    let usedFallback = false;
    if (!diagnosis) {
      diagnosis = heuristicClassify(cleanText);
      usedFallback = true;
    }

    const plan = decidePlan(diagnosis);
    const similar = findSimilar(memory, diagnosis.category);

    const incident = {
      id: 'inc_' + crypto.randomBytes(5).toString('hex'),
      category: diagnosis.category,
      targetLabel: diagnosis.targetLabel,
      confidence: diagnosis.confidence,
      evidence: diagnosis.evidence,
      contradicting: [],
      plan,
      revenue: null, // no live telemetry backs a freeform report — no fabricated number
      similar,
      source: 'freeform',
      userReportedText: cleanText || null,
      hadImage: !!imageBase64,
      successRateBefore: null,
      successRateAfter: null,
      createdAt: Date.now(),
      auditLog: [],
      narrative: null,
      customerNotice: null,
      status: 'open',
      outcome: 'ongoing',
    };

    audit(incident, `Self-reported issue received${usedFallback ? ' — interpreted via keyword fallback (Gemini not available)' : ' — interpreted by Gemini'}.`);
    audit(incident, `Diagnosis: ${diagnosis.category} (${diagnosis.confidence}% confidence).${diagnosis.targetLabel ? ` Target: ${diagnosis.targetLabel}.` : ''}`);
    if (similar) audit(incident, `Similar past incident found (${similar.id}).`);

    if (plan.autonomyTier === 'human_only') {
      incident.status = 'escalated';
      audit(incident, `Escalated to human — ${plan.note}`);
    } else if (plan.autonomyTier === 'auto') {
      audit(incident, `Auto-applying action — ${plan.note}`);
      // Awaited (unlike the scenario/tick-loop path) because this incident
      // resolves immediately — if we fired these async and recorded to
      // memory right away, the narrative/notice would never make it into
      // the permanent record even though Gemini would answer moments later.
      const [notice, narrative] = await Promise.all([
        generateCustomerNotice(diagnosis, plan),
        usedFallback ? Promise.resolve(null) : generateNarrative(diagnosis),
      ]);
      if (notice) incident.customerNotice = notice;
      if (narrative) incident.narrative = narrative;
      finalizeResolution(incident, {
        healedRate: null,
        note: 'Action applied for this self-reported issue. (No live simulated traffic is tied to a typed report, so no automatic recovery curve is shown here — the action itself is still logged and auditable.)',
      });
    } else if (plan.autonomyTier === 'investigate_further') {
      audit(incident, `Confidence too low to act — flagged for manual investigation. ${plan.recommendation}`);
    } else {
      audit(incident, `Awaiting human approval — ${plan.note || 'standard approval policy for this risk tier.'}`);
    }

    currentIncident = incident;
    // For non-immediately-resolved tiers, generate the narrative in the
    // background — there's no rush since resolution happens later via a
    // separate approve/resolve-manually call.
    if (plan.autonomyTier !== 'auto' && !usedFallback) {
      generateNarrative(diagnosis).then((narrative) => { if (narrative) incident.narrative = narrative; });
    }

    res.json({ ok: true, incident });
  } catch (err) {
    console.error('freeform diagnosis error', err);
    res.status(500).json({ error: 'Could not process the report. Please try again, or use a simulated scenario instead.' });
  }
});

app.post('/api/incidents/:id/approve', (req, res) => {
  if (!currentIncident || currentIncident.id !== req.params.id) return res.status(404).json({ error: 'Incident not found or no longer active' });
  if (currentIncident.status !== 'open') return res.status(400).json({ error: 'This incident is no longer awaiting approval (it may have already been actioned)' });
  if (currentIncident.plan.autonomyTier !== 'approval_required') return res.status(400).json({ error: 'This incident does not require approval' });

  if (currentIncident.source === 'freeform') {
    finalizeResolution(currentIncident, {
      healedRate: null,
      note: 'Human approved the recommended action for this self-reported issue. (No live simulated traffic is tied to it, so no recovery curve is shown — the approval itself is still logged.)',
    });
  } else {
    currentIncident.status = 'recovering';
    if (injection) { injection.status = 'recovering'; injection.recoveryProgress = 0; }
    audit(currentIncident, 'Human approved the recommended action. Beginning recovery.');
  }
  res.json({ ok: true });
});

app.post('/api/incidents/:id/resolve-manually', (req, res) => {
  if (!currentIncident || currentIncident.id !== req.params.id) return res.status(404).json({ error: 'Incident not found or no longer active' });
  const isEscalatedAndActionable = currentIncident.status === 'escalated';
  const isLowConfidenceAndActionable = currentIncident.status === 'open' && currentIncident.plan?.autonomyTier === 'investigate_further';
  if (!isEscalatedAndActionable && !isLowConfidenceAndActionable) {
    return res.status(400).json({ error: 'This incident is not in a state that can be manually resolved right now (it may have already been actioned)' });
  }

  if (currentIncident.source === 'freeform') {
    finalizeResolution(currentIncident, {
      healedRate: null,
      note: 'Operator reported manual remediation applied for this self-reported issue.',
    });
  } else {
    audit(currentIncident, 'Operator reported manual remediation applied outside this system.');
    currentIncident.status = 'recovering';
    currentIncident.outcome = 'recovered';
    if (injection) { injection.status = 'recovering'; injection.recoveryProgress = 0; }
  }
  res.json({ ok: true });
});

app.post('/api/incidents/:id/dismiss', (req, res) => {
  if (!currentIncident || currentIncident.id !== req.params.id) return res.status(404).json({ error: 'Incident not found or no longer active' });
  if (currentIncident.status !== 'resolved') return res.status(400).json({ error: 'Only a resolved incident can be dismissed' });

  currentIncident = null;
  consecutiveAnomalyTicks = 0;
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  tickHistory = [];
  injection = null;
  currentIncident = null;
  consecutiveAnomalyTicks = 0;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Razorpay Pulse backend running on http://localhost:${PORT}`);
  console.log(GEMINI_ENABLED ? 'Gemini narrative generation enabled.' : 'Running without Gemini — rule-based diagnosis still fully functional.');
});
