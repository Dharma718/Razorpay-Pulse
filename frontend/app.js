const API = '';
const POLL_MS = 1800;

const healthPill = document.getElementById('healthPill');
const heroRate = document.getElementById('heroRate');
const statOverallRate = document.getElementById('statOverallRate');
const statBaseline = document.getElementById('statBaseline');
const sparklineEl = document.getElementById('sparkline');
const methodHealthEl = document.getElementById('methodHealth');
const scenarioButtonsEl = document.getElementById('scenarioButtons');
const resetBtn = document.getElementById('resetBtn');
const errorBanner = document.getElementById('errorBanner');
const investigationBody = document.getElementById('investigationBody');
const incidentIdNote = document.getElementById('incidentIdNote');
const revGross = document.getElementById('revGross');
const revRecoverable = document.getElementById('revRecoverable');
const revProb = document.getElementById('revProb');
const recommendationText = document.getElementById('recommendationText');
const actionButtonsEl = document.getElementById('actionButtons');
const similarIncidentText = document.getElementById('similarIncidentText');
const memoryListEl = document.getElementById('memoryList');
const clearMemoryBtn = document.getElementById('clearMemoryBtn');
const brandHome = document.getElementById('brandHome');

const freeformText = document.getElementById('freeformText');
const clearTextBtn = document.getElementById('clearTextBtn');
const micBtn = document.getElementById('micBtn');
const imageInput = document.getElementById('imageInput');
const imagePreviewChip = document.getElementById('imagePreviewChip');
const imagePreviewName = document.getElementById('imagePreviewName');
const removeImageBtn = document.getElementById('removeImageBtn');
const freeformSubmitBtn = document.getElementById('freeformSubmitBtn');

const imagePreviewOverlay = document.getElementById('imagePreviewOverlay');
const imagePreviewFull = document.getElementById('imagePreviewFull');
const imagePreviewClose = document.getElementById('imagePreviewClose');

const memoryModalOverlay = document.getElementById('memoryModalOverlay');
const memoryModalContent = document.getElementById('memoryModalContent');
const memoryModalClose = document.getElementById('memoryModalClose');

const profileBtn = document.getElementById('profileBtn');
const profileDropdown = document.getElementById('profileDropdown');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profileRoleTag = document.getElementById('profileRoleTag');
const signOutBtn = document.getElementById('signOutBtn');

const METHOD_COLORS = { upi: '#818cf8', card: '#34d399', netbanking: '#fbbf24', wallet: '#f87171' };
const METHOD_LABELS = { upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet' };

let injectionActive = false;
let pendingImageBase64 = null;
let pendingImageMimeType = null;
let pendingImageDataUrl = null; // kept for the click-to-preview lightbox
let lastResolvedSummary = null; // client-side only — persists on screen until dismissed AND a new incident starts, or until Reset
let memoryCache = [];

function toggleTextClearButton() {
  clearTextBtn.hidden = freeformText.value.length === 0;
}
freeformText.addEventListener('input', toggleTextClearButton);
clearTextBtn.addEventListener('click', () => {
  freeformText.value = '';
  toggleTextClearButton();
  freeformText.focus();
});

function pct(x) { return x == null ? '—' : `${(x * 100).toFixed(1)}%`; }
function inr(paise) { return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function showError(msg) { errorBanner.textContent = msg; errorBanner.hidden = false; }
function clearError() { errorBanner.hidden = true; }

// Any user-typed text (free-form issue reports) MUST be escaped before being
// inserted via innerHTML — otherwise something as innocent as typing
// "payments under 500 are failing" or "error: <timeout>" would render as
// broken/missing HTML instead of the text the person actually typed.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- brand click scrolls to top ----
function goHome() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
brandHome.addEventListener('click', goHome);
brandHome.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') goHome(); });

// ---- config + scenario buttons ----
async function loadConfig() {
  try {
    const res = await fetch(`${API}/api/config`, { credentials: 'include' });
    const config = await res.json();
    scenarioButtonsEl.innerHTML = config.scenarios.map((s) => `<button class="scenario-btn" data-key="${s.key}">${s.label}</button>`).join('');
    document.querySelectorAll('.scenario-btn').forEach((btn) => {
      btn.addEventListener('click', () => injectScenario(btn.dataset.key));
    });
  } catch (e) { /* backend may not be up yet */ }
}

async function injectScenario(key) {
  clearError();
  try {
    const res = await fetch(`${API}/api/incidents/inject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ scenarioKey: key }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Injection failed');
  } catch (e) {
    showError(e.message || 'Could not inject scenario.');
  }
}

async function resetSimulation() {
  clearError();
  lastResolvedSummary = null;
  try {
    await fetch(`${API}/api/reset`, { method: 'POST', credentials: 'include' });
  } catch (e) {
    showError('Could not reset. Make sure the backend is running.');
  }
}
resetBtn.addEventListener('click', resetSimulation);

// ---- freeform issue reporting ----
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor) {
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  let listening = false;
  let textBeforeThisRecording = '';

  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    textBeforeThisRecording = freeformText.value;
    try {
      recognition.start();
      listening = true;
      micBtn.textContent = '🎙️ Listening…';
    } catch (e) { /* recognition already active, ignore */ }
  });
  recognition.onresult = (event) => {
    // IMPORTANT: event.results accumulates across the whole recording session,
    // and some browsers fire onresult multiple times as they refine the same
    // utterance ("Pay" -> "Payment" -> "Payment declined"). Rebuilding the
    // transcript fresh from event.results every time (rather than appending
    // onto whatever the textarea already holds) and REPLACING the textarea
    // content is what prevents each refinement from stacking on the last one.
    let sessionTranscript = '';
    for (let i = 0; i < event.results.length; i++) {
      sessionTranscript += event.results[i][0].transcript;
      if (i < event.results.length - 1) sessionTranscript += ' ';
    }
    freeformText.value = textBeforeThisRecording + (textBeforeThisRecording && sessionTranscript ? ' ' : '') + sessionTranscript;
    toggleTextClearButton();
  };
  recognition.onend = () => { listening = false; micBtn.textContent = '🎤 Speak'; };
  recognition.onerror = () => { listening = false; micBtn.textContent = '🎤 Speak'; showError('Could not capture speech — check microphone permissions.'); };
} else {
  micBtn.disabled = true;
  micBtn.title = 'Speech input is not supported in this browser — try Chrome or Edge.';
}

imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (!file) return;
  if (file.size > 4.5 * 1024 * 1024) {
    showError('Image is too large — please use a screenshot under ~4.5MB.');
    imageInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    const match = /^data:([^;]+);base64,(.*)$/.exec(reader.result);
    pendingImageBase64 = match ? match[2] : reader.result.split(',')[1];
    pendingImageMimeType = match ? match[1] : (file.type || 'image/png');
    imagePreviewName.textContent = file.name;
    imagePreviewChip.hidden = false;
  };
  reader.onerror = () => showError('Could not read that image file.');
  reader.readAsDataURL(file);
});

function clearAttachedImage() {
  pendingImageBase64 = null;
  pendingImageMimeType = null;
  pendingImageDataUrl = null;
  imageInput.value = '';
  imagePreviewChip.hidden = true;
  imagePreviewName.textContent = '';
}

imagePreviewChip.addEventListener('click', (e) => {
  if (e.target === removeImageBtn) {
    e.stopPropagation();
    clearAttachedImage();
    return;
  }
  if (pendingImageDataUrl) {
    imagePreviewFull.src = pendingImageDataUrl;
    imagePreviewOverlay.hidden = false;
  }
});
imagePreviewClose.addEventListener('click', () => { imagePreviewOverlay.hidden = true; });
imagePreviewOverlay.addEventListener('click', (e) => { if (e.target === imagePreviewOverlay) imagePreviewOverlay.hidden = true; });

async function submitFreeformIssue() {
  clearError();
  const text = freeformText.value.trim();
  if (!text && !pendingImageBase64) {
    showError('Please describe the issue or attach a screenshot first.');
    return;
  }
  freeformSubmitBtn.disabled = true;
  const original = freeformSubmitBtn.textContent;
  freeformSubmitBtn.textContent = 'Diagnosing…';
  try {
    const res = await fetch(`${API}/api/incidents/freeform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text, imageBase64: pendingImageBase64, imageMimeType: pendingImageMimeType }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not diagnose the issue.');
    freeformText.value = '';
    toggleTextClearButton();
    clearAttachedImage();
    lastResolvedSummary = null;
    await poll();
  } catch (e) {
    showError(e.message || 'Could not submit the report.');
  } finally {
    freeformSubmitBtn.disabled = false;
    freeformSubmitBtn.textContent = original;
  }
}
freeformSubmitBtn.addEventListener('click', submitFreeformIssue);

// ---- sparkline + method health ----
function renderSparkline(values) {
  if (!values.length) { sparklineEl.innerHTML = ''; return; }
  const min = Math.min(...values, 60);
  const max = Math.max(...values, 100);
  const range = Math.max(max - min, 1);
  const w = 300, h = 60;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  const color = last < 85 ? '#f87171' : last < 90 ? '#fbbf24' : '#34d399';
  sparklineEl.innerHTML = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
}

function renderMethodHealth(methodHealth) {
  methodHealthEl.innerHTML = methodHealth.map((m) => {
    const pctVal = Math.round(m.rate * 100);
    const color = m.rate < 0.85 ? '#f87171' : m.rate < 0.9 ? '#fbbf24' : (METHOD_COLORS[m.method] || '#818cf8');
    return `
      <div class="method-bar-row">
        <span class="method-bar-label">${METHOD_LABELS[m.method] || m.method}</span>
        <span class="method-bar-track"><span class="method-bar-fill" style="width:${pctVal}%;background:${color}"></span></span>
        <span class="method-bar-value">${pctVal}%</span>
      </div>`;
  }).join('');
}

function statusLabel(incident) {
  const map = { open: 'Awaiting approval', escalated: 'Escalated to human', recovering: 'Recovery in progress', resolved: 'Resolved' };
  return map[incident.status] || incident.status;
}

// ---- building the post-Dismiss "successfully resolved" summary ----
function buildResolvedSummary(incident) {
  const title = `${incident.category.replace(/_/g, ' ')}${incident.targetLabel && incident.targetLabel !== 'user-reported' ? ` — ${escapeHtml(incident.targetLabel)}` : ''}`;
  const issueLine = incident.source === 'freeform' && incident.userReportedText
    ? `Self-reported: "${escapeHtml(incident.userReportedText)}"`
    : escapeHtml((incident.evidence && incident.evidence[0]) || 'No detailed evidence was recorded for this incident.');
  const reasonLine = (incident.evidence && incident.evidence.length) ? escapeHtml(incident.evidence.join(' ')) : issueLine;
  const howResolved = incident.plan?.recommendation || 'No specific recommendation was recorded.';
  const outcomeLine = (incident.successRateBefore != null && incident.successRateAfter != null)
    ? `Success rate recovered from ${pct(incident.successRateBefore)} to ${pct(incident.successRateAfter)}.`
    : 'This was a self-reported issue with no live simulated traffic tied to it, so no measured recovery curve applies here — the recommended action was still logged and applied.';
  const revenueLine = (incident.revenueProtectedPaise != null && !Number.isNaN(incident.revenueProtectedPaise))
    ? ` Estimated revenue protected: ${inr(incident.revenueProtectedPaise)}.`
    : '';
  return { title, issueLine, reasonLine, howResolved, outcomeLine, revenueLine, confidence: incident.confidence };
}

function renderResolvedSummaryHTML(summary) {
  return `
    <div class="resolved-summary">
      <span class="resolved-summary-badge">&#9989; Successfully Resolved</span>
      <h3>${summary.title}</h3>
      <p><strong>Issue:</strong> ${summary.issueLine}</p>
      <p><strong>Key reason it happened:</strong> ${summary.reasonLine}</p>
      <p><strong>How it was resolved:</strong> ${summary.howResolved}</p>
      <p><strong>Outcome:</strong> ${summary.outcomeLine}${summary.revenueLine}</p>
      <p class="mono">Diagnosis confidence: ${summary.confidence}%</p>
    </div>
  `;
}

// ---- investigation panel ----
function renderInvestigation(incident) {
  const existingTrail = investigationBody.querySelector('.audit-trail');
  let scrollState = null;
  if (existingTrail) {
    const atBottom = existingTrail.scrollHeight - existingTrail.scrollTop - existingTrail.clientHeight < 10;
    scrollState = { atBottom, scrollTop: existingTrail.scrollTop };
  }

  if (!incident) {
    investigationBody.innerHTML = lastResolvedSummary
      ? renderResolvedSummaryHTML(lastResolvedSummary)
      : `<div class="ledger-empty">System is healthy. Inject a scenario, or describe your own issue below, to watch the agent investigate it.</div>`;
    incidentIdNote.textContent = lastResolvedSummary ? 'Showing last resolved incident' : 'No active incident';
    recommendationText.textContent = 'No recommendation yet.';
    actionButtonsEl.innerHTML = '';
    revGross.textContent = '—'; revRecoverable.textContent = '—'; revProb.textContent = '—';
    similarIncidentText.textContent = 'None yet — this will populate once at least one incident has been resolved.';
    return;
  }

  incidentIdNote.textContent = incident.id;

  const badgeClass = incident.status === 'resolved' ? 'resolved'
    : incident.status === 'escalated' ? 'escalated'
    : incident.status === 'recovering' ? 'recovering'
    : 'open';

  investigationBody.innerHTML = `
    <div class="incident-header">
      <span class="incident-title">${incident.category.replace(/_/g, ' ')}${incident.targetLabel && incident.targetLabel !== 'user-reported' ? ` — ${escapeHtml(incident.targetLabel)}` : ''}${incident.source === 'freeform' ? '<span class="freeform-tag">user-reported</span>' : ''}</span>
      <span class="status-badge ${badgeClass}">${statusLabel(incident)}</span>
    </div>
    <div class="confidence-tag">Confidence: ${incident.confidence}%</div>
    ${incident.userReportedText ? `<p class="recommendation-text"><strong>Your description:</strong> "${escapeHtml(incident.userReportedText)}"${incident.hadImage ? ' (screenshot attached)' : ''}</p>` : ''}
    <ul class="evidence-list">${incident.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
    ${incident.contradicting?.length ? `<ul class="evidence-list contradicting">${incident.contradicting.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
    ${incident.narrative ? `<div class="narrative-box"><span class="narrative-label">&#10024; agent narrative</span>${escapeHtml(incident.narrative)}</div>` : ''}
    ${incident.customerNotice ? `<div class="narrative-box"><span class="narrative-label">&#10024; customer notice sent</span>${escapeHtml(incident.customerNotice)}</div>` : ''}
    <div class="audit-trail">
      ${incident.auditLog.map((a) => `
        <div class="audit-row">
          <span class="audit-time">${new Date(a.at).toLocaleTimeString()}</span>
          <span>${escapeHtml(a.message)}</span>
        </div>`).join('')}
    </div>
  `;

  if (incident.revenue) {
    revGross.textContent = inr(incident.revenue.grossExposurePaise);
    revRecoverable.textContent = inr(incident.revenue.recoverableEstimatePaise);
    revProb.textContent = pct(incident.revenue.recoveryProbability);
  } else {
    revGross.textContent = 'N/A'; revRecoverable.textContent = 'N/A'; revProb.textContent = 'N/A';
  }

  recommendationText.textContent = incident.plan.recommendation || 'No automated recommendation for this pattern.';
  if (incident.source === 'freeform' && !incident.revenue) {
    recommendationText.textContent += ' (No live telemetry is tied to a self-reported issue, so no revenue figure is shown.)';
  }

  actionButtonsEl.innerHTML = '';
  if (incident.status === 'open' && incident.plan.autonomyTier === 'approval_required') {
    const btn = document.createElement('button');
    btn.className = 'action-btn approve';
    btn.textContent = 'Approve action';
    btn.onclick = () => approveIncident(incident.id);
    actionButtonsEl.appendChild(btn);
  } else if (incident.status === 'escalated' || (incident.status === 'open' && incident.plan.autonomyTier === 'investigate_further')) {
    const btn = document.createElement('button');
    btn.className = 'action-btn resolve';
    btn.textContent = 'I\'ve applied a manual fix';
    btn.onclick = () => resolveManually(incident.id);
    actionButtonsEl.appendChild(btn);
  } else if (incident.status === 'resolved') {
    const btn = document.createElement('button');
    btn.className = 'action-btn dismiss';
    btn.textContent = 'Dismiss';
    btn.onclick = () => dismissIncident(incident);
    actionButtonsEl.appendChild(btn);
  }

  if (incident.similar) {
    const protectedAmount = incident.similar.revenueProtectedPaise;
    const protectedText = (protectedAmount != null && !Number.isNaN(protectedAmount)) ? inr(protectedAmount) : 'an unrecorded amount';
    similarIncidentText.textContent = `A similar "${incident.similar.category.replace(/_/g, ' ')}" incident recovered from ${pct(incident.similar.successRateBefore)} to ${pct(incident.similar.successRateAfter)}, protecting ${protectedText}.`;
  } else {
    similarIncidentText.textContent = 'No precedent found — this is the first incident of this type recorded.';
  }

  const newTrail = investigationBody.querySelector('.audit-trail');
  if (newTrail) {
    if (scrollState && !scrollState.atBottom) newTrail.scrollTop = scrollState.scrollTop;
    else newTrail.scrollTop = newTrail.scrollHeight;
  }
}

async function approveIncident(id) {
  clearError();
  const btn = actionButtonsEl.querySelector('.action-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/incidents/${id}/approve`, { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error((await res.json()).error);
    await poll();
  } catch (e) { showError(e.message || 'Could not approve.'); if (btn) btn.disabled = false; }
}
async function resolveManually(id) {
  clearError();
  const btn = actionButtonsEl.querySelector('.action-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/incidents/${id}/resolve-manually`, { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error((await res.json()).error);
    await poll();
  } catch (e) { showError(e.message || 'Could not resolve.'); if (btn) btn.disabled = false; }
}
async function dismissIncident(incident) {
  clearError();
  lastResolvedSummary = buildResolvedSummary(incident);
  const btn = actionButtonsEl.querySelector('.action-btn');
  if (btn) btn.disabled = true;
  try {
    await fetch(`${API}/api/incidents/${incident.id}/dismiss`, { method: 'POST', credentials: 'include' });
  } catch (e) { /* if this fails, next poll will just show it as still active — non-fatal */ }
  await poll();
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ---- incident memory ----
async function renderMemory() {
  try {
    const res = await fetch(`${API}/api/incidents`, { credentials: 'include' });
    memoryCache = await res.json();
    if (!memoryCache.length) {
      memoryListEl.innerHTML = `<div class="ledger-empty">No resolved incidents yet.</div>`;
      return;
    }
    memoryListEl.innerHTML = memoryCache.map((m, i) => `
      <div class="memory-item" data-idx="${i}" role="button" tabindex="0">
        <div>
          <div class="mem-cat">${m.category.replace(/_/g, ' ')}${m.targetLabel && m.targetLabel !== 'user-reported' ? ` — ${escapeHtml(m.targetLabel)}` : ''}${m.source === 'freeform' ? '<span class="freeform-tag">user-reported</span>' : ''}</div>
          <div class="mem-detail">${m.successRateBefore != null ? `${pct(m.successRateBefore)} → ${pct(m.successRateAfter)} · ` : ''}confidence ${m.confidence}%</div>
        </div>
        <div class="mem-right">
          <div class="mem-detail">${formatDateTime(m.resolvedAt)}</div>
          <button class="mem-delete-btn" data-id="${m.id}" title="Delete this entry" aria-label="Delete this history entry">&times;</button>
        </div>
      </div>
    `).join('');
    memoryListEl.querySelectorAll('.memory-item').forEach((el) => {
      const open = () => openMemoryModal(memoryCache[Number(el.dataset.idx)]);
      el.addEventListener('click', (e) => {
        if (e.target.closest('.mem-delete-btn')) return; // handled separately below
        open();
      });
      el.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.target.closest('.mem-delete-btn')) open(); });
    });
    memoryListEl.querySelectorAll('.mem-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this history entry? This cannot be undone.')) return;
        try {
          await fetch(`${API}/api/memory/${btn.dataset.id}`, { method: 'DELETE', credentials: 'include' });
          await renderMemory();
        } catch (err) {
          showError('Could not delete that entry. Make sure the backend is running.');
        }
      });
    });
  } catch (e) { /* ignore */ }
}

function openMemoryModal(entry) {
  memoryModalContent.innerHTML = `
    <div class="incident-header">
      <span class="incident-title">${entry.category.replace(/_/g, ' ')}${entry.targetLabel && entry.targetLabel !== 'user-reported' ? ` — ${escapeHtml(entry.targetLabel)}` : ''}${entry.source === 'freeform' ? '<span class="freeform-tag">user-reported</span>' : ''}</span>
      <span class="status-badge resolved">${entry.outcome === 'recovered' ? 'Resolved' : entry.outcome}</span>
    </div>
    <div class="confidence-tag">Confidence: ${entry.confidence}%</div>
    ${entry.userReportedText ? `<p class="recommendation-text"><strong>Reported issue:</strong> "${escapeHtml(entry.userReportedText)}"</p>` : ''}
    <ul class="evidence-list">${(entry.evidence || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
    ${entry.narrative ? `<div class="narrative-box"><span class="narrative-label">&#10024; agent narrative</span>${escapeHtml(entry.narrative)}</div>` : ''}
    <div class="rail-row-wrap" style="margin:16px 0;">
      ${entry.successRateBefore != null ? `<div class="rail-row"><span class="rail-label">Success rate before</span><span class="rail-value mono">${pct(entry.successRateBefore)}</span></div>` : ''}
      ${entry.successRateAfter != null ? `<div class="rail-row"><span class="rail-label">Success rate after</span><span class="rail-value mono">${pct(entry.successRateAfter)}</span></div>` : ''}
      ${entry.revenue ? `<div class="rail-row"><span class="rail-label">Gross exposure</span><span class="rail-value mono">${inr(entry.revenue.grossExposurePaise)}</span></div>` : ''}
      ${entry.revenueProtectedPaise != null ? `<div class="rail-row"><span class="rail-label">Est. protected</span><span class="rail-value mono">${inr(entry.revenueProtectedPaise)}</span></div>` : ''}
    </div>
    <p class="recommendation-text"><strong>Recommendation:</strong> ${entry.plan?.recommendation || 'n/a'}</p>
    <div class="audit-trail" style="max-height:180px;">
      ${(entry.auditLog || []).map((a) => `<div class="audit-row"><span class="audit-time">${new Date(a.at).toLocaleTimeString()}</span><span>${escapeHtml(a.message)}</span></div>`).join('')}
    </div>
    <p class="mono" style="color:var(--text-dim); font-size:0.75rem; margin-top:12px;">Resolved at ${formatDateTime(entry.resolvedAt)}</p>
  `;
  memoryModalOverlay.hidden = false;
}
memoryModalClose.addEventListener('click', () => { memoryModalOverlay.hidden = true; });
memoryModalOverlay.addEventListener('click', (e) => { if (e.target === memoryModalOverlay) memoryModalOverlay.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') memoryModalOverlay.hidden = true; });

clearMemoryBtn.addEventListener('click', async () => {
  if (!confirm('Clear all incident history? This cannot be undone.')) return;
  try {
    await fetch(`${API}/api/memory/clear`, { method: 'POST', credentials: 'include' });
    await renderMemory();
  } catch (e) { showError('Could not clear history. Make sure the backend is running.'); }
});

// ---- main poll loop ----
async function poll() {
  try {
    const res = await fetch(`${API}/api/state`, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const d = await res.json();

    healthPill.textContent = d.health === 'healthy' ? 'system healthy' : d.health === 'degraded' ? 'degraded' : 'critical';
    healthPill.className = 'pill ' + (d.health === 'healthy' ? 'live' : d.health === 'degraded' ? 'mock' : 'critical');

    heroRate.textContent = pct(d.overallSuccessRate);
    statOverallRate.textContent = pct(d.overallSuccessRate);
    statBaseline.textContent = pct(d.baseline);

    renderSparkline(d.sparkline);
    renderMethodHealth(d.methodHealth);
    renderInvestigation(d.currentIncident);

    document.querySelectorAll('.scenario-btn').forEach((btn) => {
      btn.disabled = d.injectionActive;
      btn.title = d.injectionActive ? 'Dismiss or resolve the current incident first' : '';
    });
    freeformSubmitBtn.disabled = d.injectionActive;
    freeformSubmitBtn.title = d.injectionActive ? 'Dismiss or resolve the current incident before reporting a new one' : '';

    if (injectionActive && !d.injectionActive) renderMemory(); // an incident just fully cleared — refresh memory
    injectionActive = d.injectionActive;
  } catch (e) {
    healthPill.textContent = 'backend not running';
  }
}

// ---- must be signed in to see anything below this point ----
async function checkAuthOrRedirect() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) { window.location.href = '/login.html'; return null; }
    return await res.json();
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
}

function toggleProfileDropdown(forceClose) {
  const shouldOpen = forceClose ? false : profileDropdown.hidden;
  profileDropdown.hidden = !shouldOpen;
  profileBtn.setAttribute('aria-expanded', String(shouldOpen));
}
profileBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleProfileDropdown(); });
document.addEventListener('click', (e) => { if (!profileDropdown.hidden && !profileDropdown.contains(e.target)) toggleProfileDropdown(true); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleProfileDropdown(true); });

signOutBtn.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* redirect anyway */ }
  window.location.href = '/login.html';
});

(async function init() {
  const user = await checkAuthOrRedirect();
  if (!user) return; // already redirecting to /login.html

  profileName.textContent = user.name || (user.role === 'demo' ? 'Recruiter Demo' : 'Account');
  profileEmail.textContent = user.email;
  profileRoleTag.textContent = user.role === 'demo' ? 'Demo Account' : 'Owner';
  document.body.style.visibility = 'visible';

  await loadConfig();
  await renderMemory();
  await poll();
  setInterval(poll, POLL_MS);
})();
