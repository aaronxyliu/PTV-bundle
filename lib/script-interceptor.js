const { instrumentJavaScript } = require("../globalize-library.js");

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const header = (headers || []).find((item) => item.name.toLowerCase() === lower);
  return header ? header.value : "";
}

function isJavaScriptResponse(event) {
  const url = event.request && event.request.url ? event.request.url : "";
  const contentType = headerValue(event.responseHeaders, "content-type").toLowerCase();
  return (
    /\b(javascript|ecmascript|x-javascript)\b/.test(contentType) ||
    /(?:^|[/?&=])[^?#]*\.m?js(?:[?#]|$)/i.test(url)
  );
}

function rewriteHeaders(headers, changed) {
  const blocked = new Set([
    "content-length",
    "content-encoding",
    "etag",
    "content-security-policy",
    "content-security-policy-report-only",
  ]);
  const result = [];
  for (const header of headers || []) {
    if (blocked.has(header.name.toLowerCase())) continue;
    result.push(header);
  }
  if (changed && !result.some((item) => item.name.toLowerCase() === "content-type")) {
    result.push({ name: "content-type", value: "application/javascript; charset=utf-8" });
  }
  return result;
}

function makeEmptyStats() {
  return {
    scriptsSeen: 0,
    scriptsInstrumented: 0,
    scriptsParseFailed: 0,
    scriptsErrored: 0,
    scripts: [],
  };
}

async function installScriptInterceptor(page, stats) {
  const client = await page.target().createCDPSession();
  // CDP Fetch pauses JavaScript responses before the renderer executes them.
  await client.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Response" }],
  });

  client.on("Fetch.requestPaused", async (event) => {
    if (!event.responseStatusCode || !isJavaScriptResponse(event)) {
      await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
      return;
    }

    const scriptReport = {
      url: event.request.url,
      status: event.responseStatusCode,
      changed: false,
      parseError: "",
      sourceType: "",
      webpackPattern: "",
      warnings: [],
      error: "",
    };
    stats.scriptsSeen += 1;

    try {
      const bodyResult = await client.send("Fetch.getResponseBody", { requestId: event.requestId });
      const originalSource = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, "base64").toString("utf8")
        : bodyResult.body;

      const transformed = instrumentJavaScript(originalSource);

      scriptReport.changed = transformed.changed;
      scriptReport.parseError = transformed.metadata.parseError || "";
      scriptReport.sourceType = transformed.metadata.sourceType || "";
      scriptReport.webpackPattern = transformed.metadata.webpackPattern || "";
      scriptReport.warnings = transformed.metadata.warnings || [];
      stats.scriptsInstrumented += transformed.changed ? 1 : 0;
      stats.scriptsParseFailed += transformed.metadata.parseError ? 1 : 0;

      const responseBody = Buffer.from(
        transformed.changed ? transformed.code : originalSource,
        "utf8",
      ).toString("base64");

      await client.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: event.responseStatusCode,
        responsePhrase: event.responseStatusText || "OK",
        responseHeaders: rewriteHeaders(event.responseHeaders, transformed.changed),
        body: responseBody,
      });
    } catch (error) {
      scriptReport.error = error.message;
      stats.scriptsErrored += 1;
      await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    } finally {
      stats.scripts.push(scriptReport);
    }
  });

  return client;
}

function normalizeInstrumentationStats(stats) {
  return {
    scripts_seen: stats.scriptsSeen,
    scripts_instrumented: stats.scriptsInstrumented,
    scripts_failed: stats.scriptsParseFailed + stats.scriptsErrored,
    scripts_parse_failed: stats.scriptsParseFailed,
    scripts_errored: stats.scriptsErrored,
    scripts: stats.scripts,
  };
}

module.exports = {
  headerValue,
  isJavaScriptResponse,
  rewriteHeaders,
  makeEmptyStats,
  installScriptInterceptor,
  normalizeInstrumentationStats,
};
