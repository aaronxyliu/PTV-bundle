const { crawlVariant } = require("./ptv-runner.js");
const { normalizeInstrumentationStats } = require("./script-interceptor.js");

function detectionKey(item) {
  return JSON.stringify({
    libname: item.libname || "",
    version: item.version || [],
  });
}

function computeNewLibraries(baseline, instrumented) {
  const baselineKeys = new Set((baseline || []).map(detectionKey));
  return (instrumented || []).filter((item) => !baselineKeys.has(detectionKey(item)));
}

async function crawlPair(browser, target, args) {
  const startedAt = new Date().toISOString();
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

  return {
    crawl_started_at: startedAt,
    crawl_ended_at: new Date().toISOString(),
    rank: target.rank,
    domain: target.domain,
    url: target.url,
    baseline: baseline.result,
    instrumented: instrumented.result,
    new_libraries: computeNewLibraries(baseline.result.detected, instrumented.result.detected),
    instrumentation: normalizeInstrumentationStats(instrumented.stats),
    page_state: pageState,
  };
}

function summarize(record) {
  return {
    domain: record.domain,
    baseline_status: record.baseline.status,
    instrumented_status: record.instrumented.status,
    baseline_count: record.baseline.detected.length,
    instrumented_count: record.instrumented.detected.length,
    new_count: record.new_libraries.length,
    scripts_seen: record.instrumentation.scripts_seen,
    scripts_instrumented: record.instrumentation.scripts_instrumented,
    baseline_libs: record.baseline.detected.map((item) => `${item.libname}:${JSON.stringify(item.version)}`),
    instrumented_libs: record.instrumented.detected.map((item) => `${item.libname}:${JSON.stringify(item.version)}`),
  };
}

module.exports = {
  detectionKey,
  computeNewLibraries,
  crawlPair,
  summarize,
};
