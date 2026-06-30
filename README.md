# PTV-bundle

[![Test](https://github.com/aaronxyliu/PTV-bundle/actions/workflows/test.yml/badge.svg)](https://github.com/aaronxyliu/PTV-bundle/actions/workflows/test.yml)
![Webpack globalization cases](https://img.shields.io/badge/webpack%20globalization-13%20passing%20cases-brightgreen)

PTV-bundle extends [PTV](https://github.com/aaronxyliu/PTV.git) so it can detect front-end JavaScript libraries that are hidden inside bundled Webpack module scopes.

PTV’s original detection model extracts a runtime property tree (**pTree**) from the browser `window` object and matches it against library fingerprints. That works well when a library exposes a root variable such as `window.$`, `window.jQuery`, or `window.React`. Modern Webpack bundles often keep third-party libraries inside bundle-local module scopes, so the library object exists during execution but is not reachable from `window`.

PTV-bundle addresses this by instrumenting Webpack module factories before the browser executes them. The instrumentation mirrors module exports into:

```js
window.varStorage.modules
```

The bundled-library-aware PTV detector can then inspect both normal `window` roots and synthetic roots derived from `window.varStorage.modules`.

## Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Inputs and Outputs](#inputs-and-outputs)
- [Command Reference](#command-reference)
- [Database Import](#database-import)
- [Testing and CI](#testing-and-ci)
- [Project Layout](#project-layout)
- [Contributing and Maintenance](#contributing-and-maintenance)
- [Preliminary Results](#preliminary-results)
- [Limitations](#limitations)

## Features

- Detects front-end libraries hidden inside bundled Webpack modules for one URL or a list of URLs.
- Intercepts JavaScript responses before browser execution using Chrome DevTools Protocol.
- Instruments recognized Webpack require/cache wrappers so module exports become observable.
- Falls back to entry-level `require(moduleId)` exposure when the central wrapper is not recognizable.
- Records script-level instrumentation diagnostics for auditing.
- Writes detection-focused JSONL records and compact CSV summaries.
- Optionally imports detection results into MySQL.
- Includes automated Webpack globalization tests across Webpack 3, 4, and 5.
- Includes CI hardening, Dependabot configuration, issue templates, and contribution/security guidance.

## How It Works

For each target URL, the detector loads the page with PTV and response-phase JavaScript instrumentation enabled. JavaScript bundles are rewritten before execution so Webpack module exports become visible to PTV through `window.varStorage.modules`.

The JSONL output exposes the primary result through:

- `detection`: the PTV result from the instrumented page environment;
- `bundled_libraries`: the detected library/version objects;
- `instrumentation`: script-level information about which JavaScript responses were seen, rewritten, or failed.

For auditability, the tool also retains baseline fields internally in each record. Normal users can focus on `detection` and `bundled_libraries`.

### Response-Phase Instrumentation

`lib/script-interceptor.js` uses Chrome DevTools Protocol `Fetch` interception at response time:

```js
Fetch.enable({
  patterns: [{ urlPattern: "*", requestStage: "Response" }]
})
```

For JavaScript responses, it reads the response body, calls `instrumentJavaScript` from `globalize-library.js`, and fulfills the browser request with the transformed code. This timing matters: Webpack factories must be instrumented during the library loading phase. Injecting code after page initialization is too late for many bundle-local exports.

### Webpack Export Globalization

The globalizer parses JavaScript with Acorn and applies two Webpack-specific strategies:

1. `lib/globalize/require-wrapper.js` looks for the central Webpack require/cache wrapper. This is the preferred path because it observes each module export after the factory executes and before the wrapper returns.
2. `lib/globalize/entry-require.js` falls back to exposing entry-level direct `require(moduleId)` variables when the central wrapper is not recognizable.

When the require-wrapper strategy finds a module export expression, it inserts code equivalent to:

```js
window.varStorage = window.varStorage || {};
window.varStorage.modules = window.varStorage.modules || {};
window.varStorage.modules[moduleId] = module.exports;
```

The instrumentation is intended to create an observational side channel for PTV, not a stable application API.

### PTV Bundle Detection

The bundled-library-aware PTV detector searches:

- normal runtime roots under `window`;
- synthetic roots derived from `window.varStorage.modules`.

For each module export, PTV maps known library root aliases onto the export object and applies its existing property-tree fingerprint logic. This allows PTV to detect libraries whose root object is otherwise hidden inside Webpack.

## Installation

Install Node dependencies:

```bash
npm install
```

Set up the local PTV checkout:

```bash
npm run setup:ptv
```

`npm run setup:ptv` clones or updates PTV from:

```text
https://github.com/aaronxyliu/PTV.git
```

The cloned PTV directory is stored in `external/PTV`, which is ignored by git. This repository intentionally does not vendor PTV source code or a packed `PTV.crx`.

If you already have a local PTV checkout, pass it at runtime:

```bash
npm run detect -- --url https://example.com/ --ptv-dir /path/to/PTV
```

## Quick Start

Detect bundled libraries on one URL:

```bash
npm run detect -- \
  --url https://baidu.com/ \
  --output results/baidu-detections.jsonl \
  --output-csv results/baidu-detections.csv
```

Detect bundled libraries for a URL list:

```bash
npm run detect -- \
  --input data/china_accessible_sites.csv \
  --limit 15 \
  --output results/china-sites-detections.jsonl \
  --output-csv results/china-sites-detections.csv
```

Detect a URL list and import each result to MySQL as soon as that URL finishes:

```bash
npm run detect -- \
  --input data/china_accessible_sites.csv \
  --limit 15 \
  --output results/china-sites-detections.jsonl \
  --output-csv results/china-sites-detections.csv \
  --database debundle_stage2 \
  --table-prefix ptv_bundle_detection
```

## Inputs and Outputs

The detector accepts either `--url` or `--input`.

Supported input-file rows:

```text
1,baidu.com
2,https://qq.com/
taobao.com
https://jd.com/
```

Bare domains are normalized to HTTPS URLs.

The JSONL output contains one record per target. The main detection fields are:

- target URL and final URL;
- `detection`, the bundled-library-aware PTV result;
- `bundled_libraries`, the detected library/version pairs;
- script-level instrumentation logs;
- page-state and consent-dialog metadata.

The record also includes baseline/instrumented audit fields that were used for the preliminary comparison study. The CSV output is a compact summary for spreadsheet analysis.

## Command Reference

```text
--url <url>                   Detect bundled libraries on one URL/domain.
--input <file>                URL list file.
--limit <n>                   Number of input rows to run. Default: 15.
--offset <n>                  Input rows to skip. Default: 0.
--output <file>               JSONL output. Default: ptv-bundle-detections.jsonl.
--output-csv <file>           CSV output. Default: ptv-bundle-detections.csv.
--database <name>             Optional MySQL import after each URL detection.
--table-prefix <prefix>       Database table prefix.
--append                      Append to existing outputs instead of replacing them.
--chrome-path <path>          Chrome/Chromium executable.
--ptv-dir <path>              Unpacked PTV extension directory. Default: external/PTV.
--headless <false|new|true>   Chrome mode. Default: false.
--timeout-ms <ms>             Page navigation timeout. Default: 45000.
--settle-ms <ms>              Wait after DOMContentLoaded. Default: 7000.
--detect-timeout-ms <ms>      PTV result wait budget. Default: 20000.
--consent-policy <policy>     privacy-preserving, accept, or none.
--no-scroll                   Disable simple scroll before PTV detection.
```

## Database Import

Database import uses Python:

```bash
python3 -m pip install PyMySQL python-dotenv
```

Create `.env`:

```text
DB_HOST=127.0.0.1
DB_USERNAME=<user>
DB_PASSWORD=<password>
DB_DATABASE=<database name>
```

Then run the detector with `--database`.

When `--database` is set, each URL result is inserted immediately after that URL finishes and after its JSONL/CSV rows are written. This keeps collected data available even if a later URL times out or the run is interrupted.

The importer creates:

- `<table-prefix>_runs`
- `<table-prefix>_script_logs`

## Testing and CI

Run the automated test suite:

```bash
npm test
```

The test suite includes:

- `tests/webpack-globalization.test.js`, which builds blank temporary web applications that import `jquery@3.7.1`, instruments the generated JavaScript assets, and executes them in a DOM-like environment.
- `tests/module-api.test.js`, which checks that public modules load, exported APIs remain available, CLI help stays stable, and the instrumentation CLI keeps its executable bit.

The Webpack globalization matrix covers Webpack 3, Webpack 4, and Webpack 5 across several runtime shapes:

- synchronous entry bundles;
- async `import("jquery")` chunks loaded through Webpack JSONP/runtime loaders;
- development, production, and minified production output;
- source-map and eval-source-map output;
- split initial chunks with `splitChunks` and `runtimeChunk`;
- custom `publicPath` and `chunkFilename`;
- UMD library output.

Each case asserts that the jQuery export is reachable through the globalized module storage:

```js
window.varStorage.modules[<some id>].fn.jquery === "3.7.1"
```

Generated fixture apps and bundles are written to the OS temp directory and removed after each test.

GitHub Actions runs the same test suite on every push and pull request across:

- **Node.js 20 LTS**: the long-term-support baseline used to catch regressions in the stable runtime.
- **Node.js 22 Current**: the newer runtime used to catch compatibility issues early.

The status badge at the top of this README links to the latest workflow result. The full `npm test` suite currently runs 16 checks: 13 Webpack globalization scenarios and 3 module/API stability checks. The `13 passing cases` badge documents the current number of Webpack globalization scenarios covered by `tests/webpack-globalization.test.js`; it is static and should be updated when cases are added or removed.

The workflow uses read-only repository permissions and cancels superseded runs on the same branch. Dependabot is configured to check npm dependencies and GitHub Actions weekly.

### Current Test Matrix

| Short Name | Webpack | Scenario | Status |
|---|---:|---|---|
| `wp3-sync` | 3 | Default synchronous entry bundle | :white_check_mark: **Passing** |
| `wp3-source-map` | 3 | Synchronous bundle with source map output | :white_check_mark: **Passing** |
| `wp3-min` | 3 | Minified synchronous bundle | :white_check_mark: **Passing** |
| `wp3-async` | 3 | Async JSONP chunk loading | :white_check_mark: **Passing** |
| `wp4-eval-source-map` | 4 | Development bundle with eval source maps | :white_check_mark: **Passing** |
| `wp4-min` | 4 | Production minified synchronous bundle | :white_check_mark: **Passing** |
| `wp4-split-runtime` | 4 | `splitChunks` with `runtimeChunk` | :white_check_mark: **Passing** |
| `wp4-async-public-path` | 4 | Async chunk with custom `publicPath` and `chunkFilename` | :white_check_mark: **Passing** |
| `wp5-dev` | 5 | Development synchronous bundle | :white_check_mark: **Passing** |
| `wp5-min` | 5 | Production minified synchronous bundle | :white_check_mark: **Passing** |
| `wp5-split-runtime` | 5 | `splitChunks` with `runtimeChunk` | :white_check_mark: **Passing** |
| `wp5-umd` | 5 | UMD library output | :white_check_mark: **Passing** |
| `wp5-async-min` | 5 | Production minified async chunk | :white_check_mark: **Passing** |

## Project Layout

```text
bin/ptv-bundle-crawl.js        CLI entrypoint for bundled-library detection
globalize-library.js           Public entrypoint and CLI for JS instrumentation
lib/cli-options.js             Command-line parsing and target loading
lib/comparison-experiment.js   Detection record assembly and audit comparison fields
lib/output.js                  JSONL, CSV, and optional MySQL import helpers
lib/ptv-runner.js              One browser visit with PTV enabled
lib/script-interceptor.js      CDP response interception and JS rewriting
lib/globalize/                 AST parsing, Webpack detection, and patching
scripts/setup_ptv.sh           PTV checkout setup
scripts/import_pair_results.py MySQL importer
tests/                         Automated Webpack globalization tests
```

## Contributing and Maintenance

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing expectations, and pull request guidance.

See [SECURITY.md](SECURITY.md) for responsible-use notes and security reporting guidance.

This project also includes:

- GitHub issue templates for bug reports and feature requests;
- a pull request template with verification reminders;
- Dependabot configuration for npm and GitHub Actions updates.

## Preliminary Results

We ran a paired crawl on 15 high-traffic sites to compare the number of libraries detected by PTV before and after instrumentation. These preliminary results are retained as evidence that response-phase globalization increases PTV’s bundled-library detection coverage, with about a 2000% increase in raw detections for this sample.

| Domain | Baseline | Instrumented | New Raw Detections | JS Seen | JS Instrumented | Status |
|---|---:|---:|---:|---:|---:|---|
| baidu.com | 3 | 67 | 64 | 37 | 20 | ok |
| qq.com | 3 | 0 | 0 | 19 | 11 | timeout |
| taobao.com | 5 | 146 | 141 | 60 | 36 | ok |
| jd.com | 4 | 189 | 185 | 100 | 40 | ok |
| bilibili.com | 3 | 94 | 91 | 10 | 6 | ok |
| zhihu.com | 7 | 252 | 247 | 64 | 56 | ok |
| weibo.com | 3 | 40 | 37 | 9 | 4 | ok |
| 163.com | 4 | 133 | 129 | 19 | 11 | ok |
| sina.com.cn | 1 | 7 | 6 | 34 | 5 | ok |
| sohu.com | 5 | 71 | 66 | 16 | 3 | ok |
| douyin.com | 3 | 0 | 0 | 170 | 141 | timeout |
| csdn.net | 5 | 71 | 66 | 17 | 11 | ok |
| alipay.com | 7 | 17 | 10 | 11 | 7 | ok |
| tmall.com | 4 | 142 | 138 | 26 | 20 | ok |
| mi.com | 2 | 2 | 0 | 1 | 0 | ok |
| TOTAL | 59 | 1231 | 1180 | 593 | 371 | - |

## Limitations

- Some sites time out under full response interception.
- Websites may serve different code across visits due to A/B testing, region, cache, or login state.
- PTV’s current property-tree matcher may over-match exposed module exports.
- This tool does not bypass logins, bot checks, or access controls.
- `window.varStorage.modules` is an observational channel and should not be interpreted as a stable application API.
