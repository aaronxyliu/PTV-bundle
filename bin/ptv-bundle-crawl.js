#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { mkdtempSync } = require("fs");
const puppeteer = require("puppeteer-core");
const { parseArgs, readTargets, usage } = require("../lib/cli-options.js");
const { appendCsv, appendJsonl, importToDatabase, prepareOutputs } = require("../lib/output.js");
const { crawlPair, summarize } = require("../lib/comparison-experiment.js");

async function launchBrowser(args, userDataDir) {
  // Puppeteer 24's enableExtensions option with pipe transport is the verified
  // loading method for PTV in current Chrome.
  return await puppeteer.launch({
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
}

function validateArgs(args) {
  if (!args.chromePath || !fs.existsSync(args.chromePath)) {
    console.error(usage());
    throw new Error("Chrome executable not found. Pass --chrome-path <path>.");
  }
  if (!args.url && args.input && !fs.existsSync(args.input)) {
    console.error(usage());
    throw new Error(`Input file not found: ${args.input}`);
  }
  if (!fs.existsSync(path.join(args.ptvDir, "manifest.json"))) {
    console.error(usage());
    throw new Error(
      `PTV manifest not found in ${args.ptvDir}. Run "npm run setup:ptv" or pass --ptv-dir <path>.`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  validateArgs(args);

  const targets = readTargets(args);
  prepareOutputs(args);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "ptv-stage2-pair-"));
  const browser = await launchBrowser(args, userDataDir);

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

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  launchBrowser,
  validateArgs,
  main,
};
