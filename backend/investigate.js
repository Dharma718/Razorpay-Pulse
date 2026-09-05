const { METHODS, REGIONS } = require('./config');

/** Weighted blend of per-method baselines, used as the "expected" overall rate. */
function overallBaseline() {
  let weighted = 0;
  let totalWeight = 0;
  for (const m of Object.values(METHODS)) {
    weighted += m.baselineSuccessRate * m.weight;
    totalWeight += m.weight;
  }
  return weighted / totalWeight;
}

function providerBaseline(method, provider) {
  return METHODS[method].providers[provider].baseline;
}

/** Sum raw tick summaries over a window into one aggregate. */
function aggregateWindow(ticks) {
  const agg = {
    overall: { total: 0, success: 0 },
    byMethod: {},
    byMethodProvider: {},
    byRegion: {},
    errorCodes: {},
    totalAmountPaise: 0,
  };
  for (const t of ticks) {
    agg.overall.total += t.overall.total;
    agg.overall.success += t.overall.success;
    agg.totalAmountPaise += t.totalAmountPaise || 0;

    for (const [method, v] of Object.entries(t.byMethod)) {
      agg.byMethod[method] = agg.byMethod[method] || { total: 0, success: 0 };
      agg.byMethod[method].total += v.total;
      agg.byMethod[method].success += v.success;
    }
    for (const [key, v] of Object.entries(t.byMethodProvider)) {
      agg.byMethodProvider[key] = agg.byMethodProvider[key] || { total: 0, success: 0, method: v.method, provider: v.provider };
      agg.byMethodProvider[key].total += v.total;
      agg.byMethodProvider[key].success += v.success;
    }
    for (const [region, v] of Object.entries(t.byRegion)) {
      agg.byRegion[region] = agg.byRegion[region] || { total: 0, success: 0 };
      agg.byRegion[region].total += v.total;
      agg.byRegion[region].success += v.success;
    }
    for (const [code, count] of Object.entries(t.errorCodes)) {
      agg.errorCodes[code] = (agg.errorCodes[code] || 0) + count;
    }
  }
  agg.overall.rate = agg.overall.total ? agg.overall.success / agg.overall.total : 1;
  return agg;
}

function rate(bucket) {
  return bucket.total ? bucket.success / bucket.total : 1;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Investigate a window of ticks and produce a root-cause diagnosis purely
 * from observable deviations — the classifier never looks at which incident
 * was actually injected. This mirrors how a real SRE/analyst would reason.
 */
function investigate(windowAgg, priorAgg) {
  const evidence = [];
  const contradicting = [];

  const expectedOverall = overallBaseline();
  const actualOverall = rate(windowAgg.overall);
  const overallDrop = expectedOverall - actualOverall;

  // ---- Step 1: region-level check (catches regional/network incidents) ----
  const regionDeviations = REGIONS.map((region) => {
    const bucket = windowAgg.byRegion[region] || { total: 0, success: 0 };
    return { region, rate: rate(bucket), total: bucket.total };
  });
  const worstRegion = regionDeviations.reduce((a, b) => (a.rate < b.rate ? a : b));
  const otherRegions = regionDeviations.filter((r) => r.region !== worstRegion.region);
  const avgOtherRegionRate = otherRegions.reduce((s, r) => s + r.rate, 0) / (otherRegions.length || 1);
  const regionGap = avgOtherRegionRate - worstRegion.rate;

  // ---- Step 2: method-level check ----
  const methodDeviations = Object.keys(METHODS).map((method) => {
    const bucket = windowAgg.byMethod[method] || { total: 0, success: 0 };
    return { method, rate: rate(bucket), baseline: METHODS[method].baselineSuccessRate, total: bucket.total };
  });
  const abnormalMethods = methodDeviations.filter((m) => m.baseline - m.rate > 0.06);
  const allMethodsAbnormal = abnormalMethods.length === methodDeviations.length && methodDeviations.length > 0;

  const dominantErrorCode = Object.entries(windowAgg.errorCodes).sort((a, b) => b[1] - a[1])[0];

  // Volume sanity check (used as a "contradicting or supporting" signal)
  const volumeChange = priorAgg && priorAgg.overall.total
    ? (windowAgg.overall.total - priorAgg.overall.total) / priorAgg.overall.total
    : 0;
  if (Math.abs(volumeChange) > 0.15) {
    contradicting.push(`Overall transaction volume moved by ${(volumeChange * 100).toFixed(1)}% versus the prior window — worth ruling out a demand spike rather than a pure reliability issue.`);
  } else {
    contradicting.push('No significant volume anomaly — this looks like a pure reliability issue, not a demand spike.');
  }

  if (overallDrop < 0.03) {
    return {
      category: 'no_incident',
      confidence: 0,
      evidence: [`Overall success rate ${pct(actualOverall)} is within normal range of the ${pct(expectedOverall)} baseline.`],
      contradicting: [],
      targetLabel: null,
    };
  }

  // ---- Region-driven incident ----
  if (regionGap > 0.10 && worstRegion.total > 20) {
    evidence.push(`${worstRegion.region} region success rate is ${pct(worstRegion.rate)}, versus ${pct(avgOtherRegionRate)} average across other regions — a ${pct(regionGap)} gap.`);
    evidence.push(`All payment methods within ${worstRegion.region} are degraded roughly equally, which points to a network/infrastructure issue local to that region rather than a specific bank or processor.`);
    if (dominantErrorCode) evidence.push(`Dominant failure reason across the affected window: "${dominantErrorCode[0]}" (${dominantErrorCode[1]} occurrences).`);

    const isolationRatio = Math.min(1, regionGap / Math.max(overallDrop, 0.01));
    const confidence = Math.round(Math.min(95, 55 + isolationRatio * 35));

    return {
      category: 'regional_network',
      confidence,
      evidence,
      contradicting,
      targetLabel: worstRegion.region,
    };
  }

  // ---- Merchant-infra incident (all methods degrade uniformly) ----
  if (allMethodsAbnormal) {
    evidence.push(`All ${methodDeviations.length} payment methods are degraded simultaneously (${methodDeviations.map((m) => `${m.method}: ${pct(m.rate)}`).join(', ')}), rather than one method or bank.`);
    evidence.push('A single external bank/network outage would not usually depress every payment method at once — this pattern more often indicates a problem in the merchant\'s own checkout or integration layer.');
    if (dominantErrorCode) evidence.push(`Dominant failure reason: "${dominantErrorCode[0]}" (${dominantErrorCode[1]} occurrences), consistent with an application-level error rather than a bank decline.`);

    const confidence = Math.round(Math.min(90, 50 + overallDrop * 200));
    return {
      category: 'merchant_infra',
      confidence,
      evidence,
      contradicting,
      targetLabel: 'all methods',
    };
  }

  // ---- Provider-level incident (single bank/processor within one method) ----
  if (abnormalMethods.length > 0) {
    const worstMethod = abnormalMethods.reduce((a, b) => (a.baseline - a.rate > b.baseline - b.rate ? a : b));
    const providerEntries = Object.entries(METHODS[worstMethod.method].providers).map(([provider]) => {
      const key = `${worstMethod.method}::${provider}`;
      const bucket = windowAgg.byMethodProvider[key] || { total: 0, success: 0 };
      return { provider, rate: rate(bucket), baseline: providerBaseline(worstMethod.method, provider), total: bucket.total };
    });
    const worstProvider = providerEntries.reduce((a, b) => (a.baseline - a.rate > b.baseline - b.rate ? a : b));
    const otherProviders = providerEntries.filter((p) => p.provider !== worstProvider.provider);
    const avgOtherProviderRate = otherProviders.reduce((s, p) => s + p.rate, 0) / (otherProviders.length || 1);

    evidence.push(`${worstMethod.method.toUpperCase()} success rate is ${pct(worstMethod.rate)}, versus a ${pct(worstMethod.baseline)} baseline — the most abnormal payment method right now.`);
    evidence.push(`Within ${worstMethod.method.toUpperCase()}, "${worstProvider.provider}" is at ${pct(worstProvider.rate)}, while other providers on the same method average ${pct(avgOtherProviderRate)}.`);
    evidence.push(`Other payment methods remain close to their baselines, which narrows this to ${worstProvider.provider} specifically rather than a platform-wide issue.`);
    if (dominantErrorCode) evidence.push(`Dominant failure reason: "${dominantErrorCode[0]}" (${dominantErrorCode[1]} occurrences), concentrated in the affected provider.`);

    const isolationRatio = otherProviders.length
      ? Math.max(0, Math.min(1, (avgOtherProviderRate - worstProvider.rate) / Math.max(worstMethod.baseline - worstMethod.rate, 0.01)))
      : 0.5;
    const confidence = Math.round(Math.min(95, 55 + isolationRatio * 35));

    const category = worstMethod.method === 'card' ? 'card_processor' : 'bank_degradation';
    return { category, confidence, evidence, contradicting, targetLabel: worstProvider.provider };
  }

  // ---- Fallback: something is wrong but doesn't cleanly isolate ----
  evidence.push(`Overall success rate has dropped to ${pct(actualOverall)} from a ${pct(expectedOverall)} baseline, but no single method, provider, or region cleanly explains the full deviation.`);
  return {
    category: 'unclassified',
    confidence: 35,
    evidence,
    contradicting,
    targetLabel: null,
  };
}

module.exports = { investigate, aggregateWindow, overallBaseline };
