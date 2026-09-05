const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'incident-memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Could not load incident memory, starting fresh:', err.message);
  }
  return [];
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error('Could not persist incident memory:', err.message);
  }
}

/** Most recent past incident of the same category, if any. */
function findSimilar(memory, category) {
  const matches = memory.filter((m) => m.category === category).sort((a, b) => b.resolvedAt - a.resolvedAt);
  return matches[0] || null;
}

function recordOutcome(memory, incident) {
  memory.unshift({
    id: incident.id,
    category: incident.category,
    targetLabel: incident.targetLabel,
    confidence: incident.confidence,
    source: incident.source || 'scenario',
    userReportedText: incident.userReportedText || null,
    evidence: incident.evidence || [],
    contradicting: incident.contradicting || [],
    narrative: incident.narrative || null,
    customerNotice: incident.customerNotice || null,
    plan: incident.plan || null,
    revenue: incident.revenue || null,
    auditLog: incident.auditLog || [],
    successRateBefore: incident.successRateBefore,
    successRateAfter: incident.successRateAfter,
    revenueProtectedPaise: incident.revenueProtectedPaise,
    outcome: incident.outcome, // 'recovered' | 'escalated' | 'ongoing'
    resolvedAt: Date.now(),
  });
  if (memory.length > 100) memory.pop();
  saveMemory(memory);
  return memory;
}

function clearMemory() {
  saveMemory([]);
  return [];
}

function deleteEntry(memory, id) {
  const filtered = memory.filter((m) => m.id !== id);
  saveMemory(filtered);
  return filtered;
}

module.exports = { loadMemory, saveMemory, findSimilar, recordOutcome, clearMemory, deleteEntry };
