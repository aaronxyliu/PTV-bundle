const assert = require("assert");
const fs = require("fs");
const test = require("node:test");

test("public modules load and expose expected APIs", () => {
  const globalizer = require("../globalize-library.js");
  const cliOptions = require("../lib/cli-options.js");
  const output = require("../lib/output.js");
  const scriptInterceptor = require("../lib/script-interceptor.js");
  const ptvRunner = require("../lib/ptv-runner.js");
  const comparisonExperiment = require("../lib/comparison-experiment.js");
  const crawlerCli = require("../bin/ptv-bundle-crawl.js");

  assert.equal(typeof globalizer.instrumentJavaScript, "function");
  assert.equal(typeof globalizer.instrumentFile, "function");
  assert.equal(typeof cliOptions.parseArgs, "function");
  assert.equal(typeof output.prepareOutputs, "function");
  assert.equal(typeof output.importRecordToDatabase, "function");
  assert.equal(typeof scriptInterceptor.installScriptInterceptor, "function");
  assert.equal(typeof ptvRunner.crawlVariant, "function");
  assert.equal(typeof comparisonExperiment.detectBundledLibraries, "function");
  assert.equal(typeof comparisonExperiment.crawlPair, "function");
  assert.equal(typeof crawlerCli.validateArgs, "function");
});

test("CLI help and target parsing stay stable", () => {
  const { parseArgs, readTargets, usage } = require("../lib/cli-options.js");

  const defaults = parseArgs(["--help"]);
  assert.equal(defaults.help, true);
  assert.match(defaults.output, /ptv-bundle-detections\.jsonl$/);
  assert.match(defaults.outputCsv, /ptv-bundle-detections\.csv$/);
  assert.equal(defaults.tablePrefix, "ptv_bundle_detection");
  assert.match(usage(), /ptv-bundle-detect --url <url>/);
  assert.match(usage(), /npm run detect -- --input <url-list\.csv>/);
  assert.deepEqual(readTargets({ url: "example.com" }), [
    {
      rank: 1,
      domain: "example.com",
      url: "https://example.com/",
    },
  ]);
});

test("globalize-library CLI remains executable", () => {
  const stat = fs.statSync(require.resolve("../globalize-library.js"));
  assert.ok(stat.mode & 0o111, "globalize-library.js should keep an executable bit");
});
