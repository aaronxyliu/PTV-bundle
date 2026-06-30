const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { JSDOM, ResourceLoader } = require("jsdom");
const { instrumentJavaScript } = require("../globalize-library.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const JQUERY_VERSION = "3.7.1";

// This suite builds real blank Webpack applications in temp directories and
// executes their instrumented output in jsdom. It intentionally covers older
// and newer Webpack runtimes, minification, source maps, split initial chunks,
// library wrappers, and async JSONP chunk loading.
const WEBPACK_CASES = [
  {
    name: "webpack3 default sync bundle",
    webpackPackage: "webpack3",
    major: 3,
    app: "sync",
  },
  {
    name: "webpack3 source-map sync bundle",
    webpackPackage: "webpack3",
    major: 3,
    app: "sync",
    devtool: "source-map",
  },
  {
    name: "webpack3 minified sync bundle",
    webpackPackage: "webpack3",
    major: 3,
    app: "sync",
    minimize: true,
  },
  {
    name: "webpack3 async JSONP chunk",
    webpackPackage: "webpack3",
    major: 3,
    app: "async",
    chunkFilename: "legacy-chunks/[name].js",
  },
  {
    name: "webpack4 eval-source-map sync bundle",
    webpackPackage: "webpack4",
    major: 4,
    app: "sync",
    mode: "development",
    devtool: "eval-source-map",
  },
  {
    name: "webpack4 production minified sync bundle",
    webpackPackage: "webpack4",
    major: 4,
    app: "sync",
    mode: "production",
    optimization: { minimize: true },
  },
  {
    name: "webpack4 splitChunks and runtimeChunk sync bundle",
    webpackPackage: "webpack4",
    major: 4,
    app: "sync",
    mode: "production",
    optimization: {
      minimize: false,
      runtimeChunk: "single",
      splitChunks: { chunks: "all" },
    },
  },
  {
    name: "webpack4 async chunk with custom publicPath",
    webpackPackage: "webpack4",
    major: 4,
    app: "async",
    mode: "production",
    chunkFilename: "async/v4-[name].[contenthash].js",
    optimization: { minimize: false },
  },
  {
    name: "webpack5 development sync bundle",
    webpackPackage: "webpack5",
    major: 5,
    app: "sync",
    mode: "development",
    devtool: false,
  },
  {
    name: "webpack5 production minified sync bundle",
    webpackPackage: "webpack5",
    major: 5,
    app: "sync",
    mode: "production",
    optimization: { minimize: true },
  },
  {
    name: "webpack5 splitChunks and runtimeChunk sync bundle",
    webpackPackage: "webpack5",
    major: 5,
    app: "sync",
    mode: "production",
    optimization: {
      minimize: false,
      runtimeChunk: "single",
      splitChunks: { chunks: "all" },
    },
  },
  {
    name: "webpack5 umd library output sync bundle",
    webpackPackage: "webpack5",
    major: 5,
    app: "sync",
    mode: "production",
    devtool: "source-map",
    output: {
      library: "BlankJqueryApp",
      libraryTarget: "umd",
      globalObject: "this",
    },
    optimization: { minimize: false },
  },
  {
    name: "webpack5 production minified async chunk",
    webpackPackage: "webpack5",
    major: 5,
    app: "async",
    mode: "production",
    chunkFilename: "async/v5-[name].[contenthash].js",
    optimization: { minimize: true },
  },
];

function writeBlankJqueryApp(rootDir, appType) {
  const srcDir = path.join(rootDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });

  const source =
    appType === "async"
      ? [
          "import('jquery').then((jqueryModule) => {",
          "  const $ = jqueryModule.default || jqueryModule;",
          "  window.blankAppJqueryVersion = $.fn.jquery;",
          "  document.body.setAttribute('data-jquery-version', $.fn.jquery);",
          "  window.blankAppAsyncDone = true;",
          "});",
        ].join("\n")
      : [
          "const $ = require('jquery');",
          "window.blankAppJqueryVersion = $.fn.jquery;",
          "document.body.setAttribute('data-jquery-version', $.fn.jquery);",
        ].join("\n");

  fs.writeFileSync(path.join(srcDir, "index.js"), source);
}

function compileWebpack(webpackPackage, config) {
  const webpack = require(webpackPackage);
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      if (stats.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true, warnings: true })));
        return;
      }
      resolve(stats);
    });
  });
}

function webpackConfig(testDir, testCase) {
  const webpack = require(testCase.webpackPackage);
  const distDir = path.join(testDir, "dist");
  const config = {
    context: testDir,
    entry: path.join(testDir, "src", "index.js"),
    target: "web",
    devtool: testCase.devtool === undefined ? false : testCase.devtool,
    output: {
      path: distDir,
      filename: "[name].js",
      chunkFilename: testCase.chunkFilename || "chunks/[name].js",
      publicPath: "/assets/",
      ...(testCase.output || {}),
    },
    resolve: {
      modules: [path.join(PROJECT_ROOT, "node_modules"), "node_modules"],
    },
  };

  if (testCase.major >= 4) {
    config.mode = testCase.mode || "development";
    config.optimization = testCase.optimization || {};
  } else if (testCase.minimize) {
    config.plugins = [new webpack.optimize.UglifyJsPlugin({ sourceMap: false })];
  }

  return config;
}

async function buildBundle(testDir, testCase) {
  writeBlankJqueryApp(testDir, testCase.app);
  const stats = await compileWebpack(testCase.webpackPackage, webpackConfig(testDir, testCase));
  return {
    distDir: path.join(testDir, "dist"),
    initialAssets: initialJavaScriptAssets(stats),
  };
}

function assetName(asset) {
  return typeof asset === "string" ? asset : asset && asset.name;
}

function initialJavaScriptAssets(stats) {
  const json = stats.toJson({ all: false, assets: true, entrypoints: true });
  const entrypoint = json.entrypoints && (json.entrypoints.main || Object.values(json.entrypoints)[0]);
  const assets = entrypoint && entrypoint.assets ? entrypoint.assets.map(assetName) : [];
  return assets.filter((name) => name && name.endsWith(".js"));
}

function listJavaScriptFiles(rootDir) {
  const result = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(fullPath);
    }
  }
  return result;
}

function instrumentBuildOutput(distDir) {
  const files = listJavaScriptFiles(distDir);
  const instrumented = new Map();
  const reports = [];

  for (const file of files) {
    const relativePath = path.relative(distDir, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    const result = instrumentJavaScript(source);
    instrumented.set(relativePath, result.changed ? result.code : source);
    reports.push({
      file: relativePath,
      changed: result.changed,
      pattern: result.metadata.webpackPattern,
      asyncChunkRegistrations: result.metadata.asyncChunkRegistrations || [],
      warnings: result.metadata.warnings || [],
    });
  }

  return { instrumented, reports };
}

class InstrumentedAssetLoader extends ResourceLoader {
  constructor(instrumentedAssets) {
    super();
    this.instrumentedAssets = instrumentedAssets;
  }

  fetch(url) {
    const parsed = new URL(url);
    let assetPath = decodeURIComponent(parsed.pathname).replace(/^\/assets\//, "");
    assetPath = assetPath.replace(/^\//, "");

    if (this.instrumentedAssets.has(assetPath)) {
      return Promise.resolve(Buffer.from(this.instrumentedAssets.get(assetPath), "utf8"));
    }

    return null;
  }
}

function scriptTagsForAssets(assets) {
  return assets
    .map((asset) => `<script src="/assets/${asset.replace(/"/g, "&quot;")}"></script>`)
    .join("\n");
}

function waitForCondition(window, predicate, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      try {
        if (predicate()) {
          window.clearInterval(timer);
          resolve();
          return;
        }
      } catch (error) {
        window.clearInterval(timer);
        reject(error);
        return;
      }

      if (Date.now() - startedAt > 5000) {
        window.clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 25);
  });
}

async function executeInstrumentedBuild(initialAssets, instrumentedAssets, appType) {
  const resourceLoader = new InstrumentedAssetLoader(instrumentedAssets);
  const dom = new JSDOM(
    `<!doctype html><html><body>${scriptTagsForAssets(initialAssets)}</body></html>`,
    {
      resources: resourceLoader,
      runScripts: "dangerously",
      url: "https://ptv-bundle.test/index.html",
    },
  );

  const errors = [];
  dom.window.addEventListener("error", (event) => {
    errors.push(event.error || event.message);
  });
  dom.window.addEventListener("unhandledrejection", (event) => {
    errors.push(event.reason);
  });

  const label = appType === "async" ? "async jQuery import" : "synchronous jQuery entry";
  await waitForCondition(
    dom.window,
    () =>
      dom.window.blankAppJqueryVersion === JQUERY_VERSION &&
      (appType !== "async" || dom.window.blankAppAsyncDone === true),
    label,
  );

  assert.deepEqual(errors, [], "bundle should execute without browser errors");
  return dom.window;
}

function findCapturedJqueryModule(window) {
  const modules = window.varStorage && window.varStorage.modules;
  assert.ok(modules, "window.varStorage.modules should be created by instrumentation");

  for (const [moduleId, moduleExports] of Object.entries(modules)) {
    if (moduleExports && moduleExports.fn && moduleExports.fn.jquery === JQUERY_VERSION) {
      return { moduleId, moduleExports };
    }
  }

  assert.fail(
    `Expected some id where window.varStorage.modules[<some id>].fn.jquery == "${JQUERY_VERSION}"`,
  );
}

for (const testCase of WEBPACK_CASES) {
  test(`${testCase.name} exposes jQuery ${JQUERY_VERSION} through window.varStorage.modules`, async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptv-webpack-globalize-"));
    try {
      const { distDir, initialAssets } = await buildBundle(testDir, testCase);
      const { instrumented, reports } = instrumentBuildOutput(distDir);

      assert.ok(initialAssets.length > 0, `${testCase.name} should emit initial JavaScript assets`);
      assert.ok(
        reports.some((report) => report.changed && report.pattern === "require-cache-wrapper"),
        `${testCase.name} should instrument at least one Webpack require wrapper`,
      );

      if (testCase.app === "async") {
        assert.ok(
          instrumented.size > initialAssets.length,
          `${testCase.name} should emit at least one lazy-loaded JavaScript chunk`,
        );
      }

      const window = await executeInstrumentedBuild(initialAssets, instrumented, testCase.app);

      assert.equal(window.blankAppJqueryVersion, JQUERY_VERSION);
      assert.equal(window.document.body.getAttribute("data-jquery-version"), JQUERY_VERSION);

      const { moduleId, moduleExports } = findCapturedJqueryModule(window);
      assert.equal(
        window.varStorage.modules[moduleId].fn.jquery,
        JQUERY_VERSION,
        `window.varStorage.modules[${JSON.stringify(moduleId)}].fn.jquery should equal ${JQUERY_VERSION}`,
      );
      assert.strictEqual(moduleExports, window.varStorage.modules[moduleId]);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
}
