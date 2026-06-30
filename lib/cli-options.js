const fs = require("fs");
const path = require("path");

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

    if (key === "help") {
      args.help = true;
      continue;
    }
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

module.exports = {
  defaultChromePath,
  parseArgs,
  usage,
  normalizeUrl,
  domainFromUrl,
  targetFromValue,
  readTargetsFromInput,
  readTargets,
};
