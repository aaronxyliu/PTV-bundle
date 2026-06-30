const { crawlVariant } = require("./ptv-runner.js");
const { normalizeInstrumentationStats } = require("./script-interceptor.js");

function detectionKey(item) {
  // Compare detections by stable library identity rather than object reference.
  // Versions can be arrays in PTV output, so JSON keeps the key deterministic.
  return JSON.stringify({
    libname: item.libname || "",
    version: item.version || [],
  });
}

function computeNewLibraries(baseline, instrumented) {
  const baselineKeys = new Set((baseline || []).map(detectionKey));
  return (instrumented || []).filter((item) => !baselineKeys.has(detectionKey(item)));
}

async function detectBundledLibraries(browser, target, args) {
  const startedAt = new Date().toISOString();
  // Run baseline first, then repeat the same target with JavaScript response
  // globalization enabled. The instrumented result is the user-facing bundled
  // library detection result; baseline is retained for diagnostics/auditing.
  const baseline = await crawlVariant(browser, target, args, false);
  const instrumented = await crawlVariant(browser, target, args, true);
  const pageState = {
    baseline: baseline.result.diagnostics.page_state || {},
    instrumented: instrumented.result.diagnostics.page_state || {},
    consent: {
      baseline: baseline.result.diagnostics.consent || {},
      instrumented: instrumented.result.diagnostics.consent || {},
    },
  };

  const newLibraries = computeNewLibraries(baseline.result.detected, instrumented.result.detected);
  return {
    crawl_started_at: startedAt,
    crawl_ended_at: new Date().toISOString(),
    rank: target.rank,
    domain: target.domain,
    url: target.url,
    detection: instrumented.result,
    bundled_libraries: instrumented.result.detected,
    baseline: baseline.result,
    instrumented: instrumented.result,
    new_libraries: newLibraries,
    instrumentation: normalizeInstrumentationStats(instrumented.stats),
    page_state: pageState,
  };
}

function summarize(record) {
  // This compact object is printed to stdout for progress monitoring; the JSONL
  // file remains the complete machine-readable record.
  return {
    domain: record.domain,
    detection_status: record.detection.status,
    detected_library_count: record.bundled_libraries.length,
    baseline_status: record.baseline.status,
    baseline_library_count: record.baseline.detected.length,
    new_count: record.new_libraries.length,
    scripts_seen: record.instrumentation.scripts_seen,
    scripts_instrumented: record.instrumentation.scripts_instrumented,
    bundled_libraries: record.bundled_libraries.map((item) => `${item.libname}:${JSON.stringify(item.version)}`),
  };
}

module.exports = {
  detectionKey,
  computeNewLibraries,
  detectBundledLibraries,
  crawlPair: detectBundledLibraries,
  summarize,
};
