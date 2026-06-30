const fs = require("fs");
const { acornEcmaVersion, parseJavaScript } = require("./ast-utils.js");
const { findAsyncChunkRegistrations, patchEntryDeclarationFallback } = require("./entry-require.js");
const { findWebpackRequireFunction, patchRequireFunction } = require("./require-wrapper.js");

// High-level instrumentation pipeline:
// 1. Parse source as a script, retry as an ES module if needed.
// 2. Try the precise Webpack require/cache wrapper patch.
// 3. If that fails, try the entry require fallback.
// 4. Return original code plus warnings when no safe patch point is found.

function metadataBase(options, asyncRegistrations) {
  return {
    changed: false,
    bundler: "webpack",
    webpackPattern: null,
    patchedRequireFunctions: 0,
    patchedEntryDeclarations: 0,
    asyncChunkRegistrations: asyncRegistrations,
    warnings: [],
    ...options.metadata,
  };
}

function parseWithFallback(code, options) {
  let parsedSourceType = options.sourceType || "script";
  try {
    return {
      ast: parseJavaScript(code, options),
      sourceType: parsedSourceType,
    };
  } catch (error) {
    if (options.sourceType) throw error;

    parsedSourceType = "module";
    return {
      ast: parseJavaScript(code, { ...options, sourceType: "module" }),
      sourceType: parsedSourceType,
    };
  }
}

function parseFailureResult(code, options, error) {
  if (options.throwOnParseError) throw error;

  const metadata = metadataBase(options, []);
  metadata.parseError = error.message;
  metadata.warnings.push(`Parse failed: ${error.message}`);
  return {
    code,
    changed: false,
    metadata,
  };
}

function instrumentJavaScript(source, options = {}) {
  const code = String(source);
  let parsed;

  try {
    parsed = parseWithFallback(code, options);
  } catch (error) {
    return parseFailureResult(code, options, error);
  }

  const { ast, sourceType } = parsed;
  const asyncRegistrations = findAsyncChunkRegistrations(ast, code);
  const metadata = metadataBase(options, asyncRegistrations);
  metadata.sourceType = sourceType;

  const requireCandidate = findWebpackRequireFunction(ast);
  if (requireCandidate) {
    const result = patchRequireFunction(code, requireCandidate);
    if (result.changed) {
      return {
        code: result.patched,
        changed: true,
        metadata: {
          ...metadata,
          changed: true,
          webpackPattern: "require-cache-wrapper",
          patchedRequireFunctions: 1,
          requireName: requireCandidate.requireName,
          moduleIdParameter: requireCandidate.moduleIdName,
        },
      };
    }

    metadata.warnings.push(`Require-function instrumentation skipped: ${result.reason}`);
  }

  const fallback = patchEntryDeclarationFallback(ast, code);
  if (fallback.changed) {
    return {
      code: fallback.patched,
      changed: true,
      metadata: {
        ...metadata,
        changed: true,
        webpackPattern: "entry-require-globalization",
        patchedEntryDeclarations: 1,
        exposedEntryRequires: fallback.exposed.map((item) => ({
          localName: item.localName,
          requireName: item.requireName,
          moduleId: item.moduleId,
        })),
      },
    };
  }

  metadata.warnings.push(`Fallback detector note: ${fallback.reason}`);
  if (asyncRegistrations.length > 0) {
    metadata.warnings.push(
      "This file looks like an async chunk. Instrument the main runtime chunk too.",
    );
  }

  return {
    code,
    changed: false,
    metadata,
  };
}

function instrumentFile(inputPath, outputPath = inputPath, options = {}) {
  const source = fs.readFileSync(inputPath, "utf8");
  const result = instrumentJavaScript(source, options);
  if (result.changed) {
    fs.writeFileSync(outputPath, result.code);
  }
  return result;
}

module.exports = {
  instrumentJavaScript,
  instrumentFile,
  metadataBase,
  parseWithFallback,
  acornEcmaVersion,
};
