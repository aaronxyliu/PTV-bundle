# PTV-bundle

PTV-bundle is a functional extension around [PTV](https://github.com/aaronxyliu/PTV.git) for detecting front-end JavaScript libraries hidden inside bundled Webpack code.

PTV’s original detection model extracts a runtime property tree (**pTree**) from the browser `window` object and matches it against library fingerprints. This works well when a library exposes a root variable such as `window.$`, `window.jQuery`, or `window.React`. However, modern Webpack bundles often keep third-party libraries inside bundle-local module scopes, so the library object exists during execution but is not reachable from `window`.

PTV-bundle addresses this gap by instrumenting Webpack module factories before the browser executes them. The instrumentation exposes module exports through:

```js
window.varStorage.modules
```

The bundled-library-aware PTV detector can then inspect both normal `window` roots and `window.varStorage.modules` roots.

## Repository Scope

This repository intentionally does not vendor the PTV source code or a packed `PTV.crx`.

Instead, setup clones PTV directly from:

```text
https://github.com/aaronxyliu/PTV.git
```

The cloned PTV directory is stored in `external/PTV`, which is gitignored.

## Code Layout

The crawler is split by responsibility so each stage can be tested or changed independently:

- `globalize-library.js` is the stable public entrypoint and CLI for JavaScript source instrumentation.
- `lib/globalize/ast-utils.js` owns Acorn parsing, AST walking, and small node-inspection helpers.
- `lib/globalize/require-wrapper.js` detects and patches Webpack require/cache wrapper functions so every initialized module export can be mirrored into `window.varStorage.modules`.
- `lib/globalize/entry-require.js` provides the fallback detector for entry-level `require(moduleId)` variables and records async chunk registration sites.
- `lib/globalize/instrumenter.js` coordinates parsing, primary instrumentation, fallback instrumentation, and metadata generation.
- `lib/script-interceptor.js` intercepts JavaScript responses in the browser with Chrome DevTools Protocol `Fetch`, runs `globalize-library.js` on each response body, and records per-script instrumentation diagnostics.
- `lib/ptv-runner.js` drives one browser visit with PTV enabled. It handles navigation, consent clicks, simple scrolling, PTV result collection, and optional response instrumentation.
- `lib/comparison-experiment.js` runs the paired experiment: one baseline visit without instrumentation, one instrumented visit, then computes the newly detected library/version pairs.
- `lib/output.js` writes JSONL/CSV results and optionally imports them into MySQL.
- `lib/cli-options.js` owns command-line parsing, URL normalization, and input-list loading.
- `bin/ptv-bundle-crawl.js` is now a thin executable that validates inputs, launches Chrome with PTV, runs the paired comparison, and writes outputs.

## Install

```bash
npm install
npm run setup:ptv
```

`npm run setup:ptv` runs:

```bash
bash scripts/setup_ptv.sh
```

It clones or updates `external/PTV`.

If you already have a local PTV checkout, pass it at runtime:

```bash
npm run crawl -- --url https://example.com/ --ptv-dir /path/to/PTV
```

## Quick Start

Run one URL:

```bash
npm run crawl -- \
  --url https://baidu.com/ \
  --output results/baidu.jsonl \
  --output-csv results/baidu.csv
```

Run a URL list:

```bash
npm run crawl -- \
  --input data/china_accessible_sites.csv \
  --limit 15 \
  --output results/china-sites.jsonl \
  --output-csv results/china-sites.csv
```

## Tests

Run the automated test suite:

```bash
npm test
```

The Webpack globalization test builds blank temporary web applications that import `jquery@3.7.1`, instruments the generated JavaScript assets, and executes them in a DOM-like environment. The matrix covers Webpack 3, Webpack 4, and Webpack 5 across several runtime shapes:

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

Generated fixture apps and bundles are written to the OS temp directory and removed after each test. The same suite runs in GitHub Actions on every push and pull request.

Run and import to MySQL:

```bash
npm run crawl -- \
  --input data/china_accessible_sites.csv \
  --limit 15 \
  --output results/china-sites.jsonl \
  --output-csv results/china-sites.csv \
  --database debundle_stage2 \
  --table-prefix ptv_pair_puppeteer
```

The importer creates:

- `<table-prefix>_runs`
- `<table-prefix>_script_logs`

## Input Format

The crawler accepts either `--url` or `--input`.

Supported input-file rows:

```text
1,baidu.com
2,https://qq.com/
taobao.com
https://jd.com/
```

Domains are normalized to HTTPS URLs.

## Outputs

The crawler writes paired before/after records.

For each URL, it performs:

1. a baseline visit with PTV enabled and no instrumentation;
2. an instrumented visit with JavaScript response rewriting enabled.

The JSONL output contains complete records:

- target URL and final URL;
- baseline PTV result;
- instrumented PTV result;
- newly detected library/version pairs;
- script-level instrumentation logs;
- page-state and consent-dialog metadata.

The CSV output is a compact summary for spreadsheet analysis.

## Technical Design

### Browser Loading

PTV is loaded as an unpacked Chrome extension through Puppeteer:

```js
puppeteer.launch({
  pipe: true,
  enableExtensions: [ptvDir]
})
```

This method was selected because current Chrome automation reliably loaded PTV with Puppeteer’s `enableExtensions` API, while Selenium CRX loading and raw `--load-extension` were unreliable in our environment.

### Response-Phase Instrumentation

`lib/script-interceptor.js` uses Chrome DevTools Protocol `Fetch` interception at response time:

```js
Fetch.enable({
  patterns: [{ urlPattern: "*", requestStage: "Response" }]
})
```

For JavaScript responses, it reads the response body, calls the `instrumentJavaScript` API exported by `globalize-library.js`, and fulfills the browser request with the transformed code. This timing matters: the instrumented module factory must run during the library loading phase. Injecting code after page initialization is too late for many bundle-local exports.

### Paired Comparison Experiment

`lib/comparison-experiment.js` compares PTV results before and after instrumentation for each target URL. It keeps the output record shape stable:

1. `baseline` stores the PTV result from a normal page load.
2. `instrumented` stores the PTV result from a page load where JavaScript responses were globalized before execution.
3. `new_libraries` contains library/version detections present only in the instrumented run.
4. `instrumentation` summarizes how many JavaScript responses were seen, changed, parse-failed, or errored.

### Webpack Export Globalization

The globalizer parses JavaScript with Acorn and then applies two Webpack-specific strategies:

1. `lib/globalize/require-wrapper.js` looks for the central Webpack require/cache wrapper. This is the preferred path because it can observe each module export after the factory executes and before the wrapper returns.
2. `lib/globalize/entry-require.js` falls back to exposing entry-level direct `require(moduleId)` variables when the central wrapper is not recognizable.

When the require-wrapper strategy finds a module export expression, it inserts code equivalent to:

```js
window.varStorage = window.varStorage || {};
window.varStorage.modules = window.varStorage.modules || {};
window.varStorage.modules[moduleId] = module.exports;
```

The result is not meant to alter application behavior. It creates an observational side channel for PTV.

### PTV Bundle Detection

The bundled-library-aware PTV detector searches:

- normal runtime roots under `window`;
- synthetic roots derived from `window.varStorage.modules`.

For each module export, PTV maps known library root aliases onto the export object and applies its existing property-tree fingerprint logic. This allows PTV to detect libraries whose root object is otherwise hidden inside Webpack.

## Preliminary Experiment Results

We ran a paired crawl on 15 high-traffic sites to compare the number of libraries detected by PTV before and after instrumentation. The following results show that instrumentation substantially increases PTV’s detection coverage ( **~2000%** improvement). 


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

## Command Reference

```text
--url <url>                   Run one URL/domain.
--input <file>                URL list file.
--limit <n>                   Number of input rows to run. Default: 15.
--offset <n>                  Input rows to skip. Default: 0.
--output <file>               JSONL output.
--output-csv <file>           CSV output.
--database <name>             Optional MySQL import after crawling.
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

## Database Setup

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

Then use `--database`.

## Limitations

- Some sites time out under full response interception.
- Websites may serve different code across visits due to A/B testing, region, cache, or login state.
- PTV’s current property-tree matcher may over-match exposed module exports.
- This tool does not bypass logins, bot checks, or access controls.
- `window.varStorage.modules` is an observational channel and should not be interpreted as a stable application API.
