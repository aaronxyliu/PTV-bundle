#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { mkdtempSync } = require("fs");
const puppeteer = require("puppeteer-core");
const { instrumentJavaScript } = require("../globalize-library.js");

function parseArgs(argv) {
  const args = {
    url: "",
    input: "",
    limit: 15,
    offset: 0,
    output: path.resolve("stage2-ptv-pair-puppeteer-results.jsonl"),
    outputCsv: path.resolve("stage2-ptv-pair-puppeteer-results.csv"),
    chromePath: defaultChromePath(),
    ptvDir: path.resolve("external/PTV"),
    database: "",
    tablePrefix: "ptv_pair_puppeteer",
    timeoutMs: 45000,
    settleMs: 7000,
    detectTimeoutMs: 20000,
    headless: "false",
    consentPolicy: "privacy-preserving",
    scroll: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (key === "noScroll") {
      args.scroll = false;
      continue;
    }
    if (key === "append") {
      args.append = true;
      continue;
    }

    if (!(key in args)) throw new Error(`Unknown option: --${rawKey}`);
    const value = inlineValue === undefined ? argv[++i] : inlineValue;
    if (value === undefined) throw new Error(`Missing value for --${rawKey}`);

    if (["input", "output", "outputCsv", "chromePath", "ptvDir"].includes(key)) {
      args[key] = path.resolve(value);
    } else if (["limit", "offset", "timeoutMs", "settleMs", "detectTimeoutMs"].includes(key)) {
      args[key] = Number(value);
    } else {
      args[key] = value;
    }
  }

  return args;
}

function usage() {
  return `Usage:
  node bin/ptv-bundle-crawl.js --url <url> [options]
  node bin/ptv-bundle-crawl.js --input <url-list.csv> [options]

Inputs:
  --url <url>                   Run one URL/domain.
  --input <file>                URL list. Each line may be "rank,domain", "rank,url", "domain", or "url".
  --limit <n>                   Number of input rows to run. Default: 15.
  --offset <n>                  Input rows to skip. Default: 0.

Outputs:
  --output <file>               JSONL output. Default: stage2-ptv-pair-puppeteer-results.jsonl.
  --output-csv <file>           Summary CSV output. Default: stage2-ptv-pair-puppeteer-results.csv.
  --database <name>             Optional MySQL database import after crawl.
  --table-prefix <prefix>       Database table prefix. Default: ptv_pair_puppeteer.
  --append                      Append to existing JSONL/CSV instead of replacing them.

Browser and detector:
  --chrome-path <path>          Chrome executable path.
  --ptv-dir <path>              Unpacked PTV extension directory. Default: external/PTV.
  --headless <false|new|true>   Chrome mode. Default: false.
  --timeout-ms <ms>             Page navigation timeout. Default: 45000.
  --settle-ms <ms>              Wait after DOMContentLoaded. Default: 7000.
  --detect-timeout-ms <ms>      PTV meta-tag wait budget. Default: 20000.
  --consent-policy <privacy-preserving|accept|none>
                                Consent dialog policy. Default: privacy-preserving.
  --no-scroll                   Disable simple page scroll before PTV detection.
`;
}

function defaultChromePath() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Empty URL/domain input");
  return /^https?:\/\//i.test(text) ? text : `https://${text}/`;
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url).replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./, "");
  }
}

function targetFromValue(value, rank) {
  const url = normalizeUrl(value);
  return {
    rank,
    domain: domainFromUrl(url),
    url,
  };
}

function readTargetsFromInput(csvPath, offset, limit) {
  const rows = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  return rows.slice(offset, offset + limit).map((row, index) => {
    const columns = row.split(",").map((item) => item.trim()).filter(Boolean);
    if (columns.length >= 2 && /^\d+$/.test(columns[0])) {
      return targetFromValue(columns[1], Number(columns[0]));
    }
    return targetFromValue(columns[0], offset + index + 1);
  });
}

function readTargets(args) {
  if (args.url) {
    return [targetFromValue(args.url, 1)];
  }
  if (args.input) {
    return readTargetsFromInput(args.input, args.offset, args.limit);
  }
  return readTargetsFromInput(path.resolve("data/china_accessible_sites.csv"), args.offset, args.limit);
}

function csvEscape(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvHeaders() {
  return [
    "rank",
    "domain",
    "url",
    "baseline_status",
    "instrumented_status",
    "baseline_final_url",
    "instrumented_final_url",
    "baseline_library_count",
    "instrumented_library_count",
    "new_library_count",
    "scripts_seen",
    "scripts_instrumented",
    "scripts_failed",
    "baseline_detected_json",
    "instrumented_detected_json",
    "new_libraries_json",
    "baseline_error",
    "instrumented_error",
  ];
}

function csvRow(record) {
  return [
    record.rank,
    record.domain,
    record.url,
    record.baseline.status,
    record.instrumented.status,
    record.baseline.final_url,
    record.instrumented.final_url,
    record.baseline.detected.length,
    record.instrumented.detected.length,
    record.new_libraries.length,
    record.instrumentation.scripts_seen,
    record.instrumentation.scripts_instrumented,
    record.instrumentation.scripts_failed,
    record.baseline.detected,
    record.instrumented.detected,
    record.new_libraries,
    record.baseline.error,
    record.instrumented.error,
  ].map(csvEscape).join(",");
}

function prepareOutputs(args) {
  for (const file of [args.output, args.outputCsv]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  if (!args.append) {
    fs.writeFileSync(args.output, "");
    fs.writeFileSync(args.outputCsv, `${csvHeaders().join(",")}\n`);
  } else if (!fs.existsSync(args.outputCsv) || fs.statSync(args.outputCsv).size === 0) {
    fs.writeFileSync(args.outputCsv, `${csvHeaders().join(",")}\n`);
  }
}

function appendCsv(file, record) {
  fs.appendFileSync(file, `${csvRow(record)}\n`);
}

function importToDatabase(args) {
  if (!args.database) return;

  const result = spawnSync(
    "python3",
    [
      path.join("scripts", "import_pair_results.py"),
      "--input",
      args.output,
      "--database",
      args.database,
      "--table-prefix",
      args.tablePrefix,
    ],
    {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Database import failed with exit code ${result.status}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function installScriptInterceptor(page, stats) {
  const client = await page.target().createCDPSession();
  // CDP Fetch pauses JavaScript responses before the renderer executes them.
  // This is the critical timing property: instrumentation happens during the
  // library loading phase, not after the page has already initialized.
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

      // The AST-based instrumenter rewrites recognized Webpack module factories
      // so that module exports become observable at window.varStorage.modules.
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

async function classifyPageState(page) {
  return await page.evaluate(() => {
    const text = document.body ? document.body.innerText.slice(0, 5000).toLowerCase() : "";
    return {
      hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
      hasCaptcha:
        text.includes("captcha") ||
        text.includes("verify you are human") ||
        text.includes("安全验证") ||
        Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="turnstile"]')),
      hasConsentText:
        text.includes("cookie") ||
        text.includes("consent") ||
        text.includes("privacy preferences"),
    };
  }).catch((error) => ({ error: error.message }));
}

async function handleConsent(page, policy) {
  if (policy === "none") return { attempted: false, clicked: false, label: "" };
  const labels =
    policy === "privacy-preserving"
      ? ["reject all", "reject", "necessary only", "essential only", "accept all", "agree", "i accept", "accept"]
      : ["accept all", "agree", "i accept", "accept", "continue"];

  return await page.evaluate((candidateLabels) => {
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a"));
    for (const label of candidateLabels) {
      const target = buttons.find((button) => {
        const text = (
          button.innerText ||
          button.value ||
          button.getAttribute("aria-label") ||
          button.getAttribute("title") ||
          ""
        ).trim().toLowerCase();
        if (!text || text.length > 80) return false;
        return text === label || text.includes(label);
      });
      if (target) {
        target.click();
        return { attempted: true, clicked: true, label };
      }
    }
    return { attempted: true, clicked: false, label: "" };
  }, labels).catch((error) => ({
    attempted: policy !== "none",
    clicked: false,
    label: "",
    error: error.message,
  }));
}

async function simpleScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let steps = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(300, window.innerHeight * 0.8));
        steps += 1;
        if (steps >= 3) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  }).catch(() => {});
}

async function waitForPtvResult(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const result = document.getElementById("lib-detect-result");
      return Boolean(result && result.getAttribute("content"));
    },
    { timeout: timeoutMs, polling: 100 },
  );

  return await page.evaluate(() => {
    const result = document.getElementById("lib-detect-result");
    const time = document.getElementById("lib-detect-time");
    const resultText = result ? result.getAttribute("content") : "";
    let detected = [];
    try {
      detected = JSON.parse(resultText || "[]");
    } catch (error) {
      detected = [{ parse_error: error.message, raw: resultText || "" }];
    }

    return {
      ok: true,
      detect_time_ms: Number(time ? time.getAttribute("content") || 0 : 0),
      detected,
      has_result_meta: Boolean(result),
      has_time_meta: Boolean(time),
    };
  });
}

async function forcePtvDetect(page) {
  await page.evaluate(() => {
    const result = document.getElementById("lib-detect-result");
    if (result) result.setAttribute("content", "");
    const time = document.getElementById("lib-detect-time");
    if (time) time.setAttribute("content", "");
    const script = Array.from(document.scripts).find((item) => item.src && item.src.includes("/content_scripts/detect.js"));
    if (!script || !script.src.startsWith("chrome-extension://")) return false;
    // PTV content_scripts/inject.js normally triggers detection automatically.
    // This fallback is useful when a page loads slowly or the first auto-detect
    // fires before late modules are initialized.
    const baseUrl = script.src.split("/content_scripts/detect.js")[0] + "/data";
    window.postMessage({ type: "detect", url: baseUrl }, "*");
    return true;
  }).catch(() => false);
}

async function collectPtv(page, timeoutMs) {
  try {
    return await waitForPtvResult(page, timeoutMs);
  } catch (firstError) {
    await forcePtvDetect(page);
    try {
      return await waitForPtvResult(page, Math.max(5000, Math.floor(timeoutMs / 2)));
    } catch (secondError) {
      return {
        ok: false,
        status: "timeout",
        error: secondError.message || firstError.message,
        detect_time_ms: 0,
        detected: [],
      };
    }
  }
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

async function crawlVariant(browser, target, args, instrument) {
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36",
  );
  page.setDefaultTimeout(args.timeoutMs);
  page.setDefaultNavigationTimeout(args.timeoutMs);

  const stats = makeEmptyStats();
  const result = {
    final_url: "",
    status: "",
    navigation_status: "",
    detect_time_ms: 0,
    detected: [],
    error: "",
    diagnostics: {},
  };

  try {
    if (instrument) await installScriptInterceptor(page, stats);
    const response = await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs,
    });
    result.navigation_status = response ? String(response.status()) : "no-response";
    result.final_url = page.url();
    await delay(args.settleMs);
    const pageState = await classifyPageState(page);
    const consent = await handleConsent(page, args.consentPolicy);
    if (args.scroll) {
      await simpleScroll(page);
      await delay(1000);
    }
    const ptv = await collectPtv(page, args.detectTimeoutMs);
    result.status = ptv.ok ? "ok" : (ptv.status || "ptv_error");
    result.detect_time_ms = ptv.detect_time_ms || 0;
    result.detected = ptv.detected || [];
    result.error = ptv.error || "";
    result.diagnostics = {
      page_state: pageState,
      consent,
      has_result_meta: ptv.has_result_meta,
      has_time_meta: ptv.has_time_meta,
    };
  } catch (error) {
    result.status = "error";
    result.error = error.message;
    result.final_url = page.url();
  } finally {
    await page.close().catch(() => {});
  }

  return { result, stats };
}

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

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.chromePath || !fs.existsSync(args.chromePath)) {
    console.error(usage());
    throw new Error("Chrome executable not found. Pass --chrome-path <path>.");
  }
  if (!args.url && args.input && !fs.existsSync(args.input)) {
    console.error(usage());
    throw new Error(`Input file not found: ${args.input}`);
  }

  const targets = readTargets(args);
  prepareOutputs(args);
  if (!fs.existsSync(path.join(args.ptvDir, "manifest.json"))) {
    console.error(usage());
    throw new Error(
      `PTV manifest not found in ${args.ptvDir}. Run "npm run setup:ptv" or pass --ptv-dir <path>.`,
    );
  }
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "ptv-stage2-pair-"));
  // Puppeteer 24's enableExtensions option with pipe transport is the verified
  // loading method for PTV in current Chrome. Selenium/CRX loading was unreliable
  // in our environment and did not register the extension.
  const browser = await puppeteer.launch({
    executablePath: args.chromePath,
    headless: args.headless === "false" ? false : args.headless,
    userDataDir,
    pipe: true,
    enableExtensions: [args.ptvDir],
    args: [
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,BackForwardCache",
      "--no-first-run",
      "--no-default-browser-check",
      "--ignore-certificate-errors",
      "--window-size=1365,900",
    ],
    defaultViewport: { width: 1365, height: 900 },
  });

  try {
    for (const target of targets) {
      console.log(`Crawling pair #${target.rank} ${target.url}`);
      const record = await crawlPair(browser, target, args);
      appendJsonl(args.output, record);
      appendCsv(args.outputCsv, record);
      console.log(JSON.stringify(summarize(record)));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  importToDatabase(args);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
