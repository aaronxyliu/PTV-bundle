#!/usr/bin/env node

// Usage: node globalize-library.js <source file path> <output file path>

const fs = require("fs");
const acorn = require("acorn");

let code = "";
let ast = null;

function acornEcmaVersion() {
  const major = Number(String(acorn.version || "").split(".")[0]);
  if (major >= 8) return "latest";
  if (major >= 6) return 2020;
  return 9;
}

function parseJavaScript(source, options = {}) {
  return acorn.parse(source, {
    ecmaVersion: acornEcmaVersion(),
    sourceType: options.sourceType || "script",
    allowHashBang: options.allowHashBang !== false,
  });
}

function walk(node, visitor, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visitor(node, parent);

  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") {
      continue;
    }

    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor, node);
    } else if (value && typeof value.type === "string") {
      walk(value, visitor, node);
    }
  }
}

function nodeCode(node) {
  return code.slice(node.start, node.end);
}

function isIdentifier(node, name = null) {
  return node && node.type === "Identifier" && (name === null || node.name === name);
}

function isLiteralModuleId(node) {
  return (
    node &&
    node.type === "Literal" &&
    (typeof node.value === "number" || typeof node.value === "string")
  );
}

function memberPropertyName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal") return String(node.property.value);
  return null;
}

function isExportsMember(node) {
  return memberPropertyName(node) === "exports";
}

function countExportsMembers(node) {
  let count = 0;
  walk(node, (child) => {
    if (isExportsMember(child)) count++;
  });
  return count;
}

function isModuleObjectLiteral(node) {
  if (!node || node.type !== "ObjectExpression") return false;
  return node.properties.some((prop) => {
    const key = prop.key;
    const name =
      key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
    return name === "exports";
  });
}

function unwrapModuleObjectInitializer(node) {
  let current = node;
  while (current && current.type === "AssignmentExpression") {
    current = current.right;
  }
  return current;
}

function exportsObjectName(node) {
  if (!isExportsMember(node)) return null;
  return node.object && node.object.type === "Identifier" ? node.object.name : null;
}

function collectCreatedModuleObjectNames(fn, beforeNode) {
  const names = new Set();

  walk(fn.body, (node) => {
    if (node.start >= beforeNode.start) return;

    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isModuleObjectLiteral(unwrapModuleObjectInitializer(node.init))
    ) {
      names.add(node.id.name);
    }

    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier" &&
      isModuleObjectLiteral(unwrapModuleObjectInitializer(node.right))
    ) {
      names.add(node.left.name);
    }
  });

  return names;
}

function wrapperExecutionArguments(call) {
  if (
    call.callee.type === "MemberExpression" &&
    memberPropertyName(call.callee) === "call"
  ) {
    return call.arguments.slice(1);
  }

  return call.arguments;
}

function getExecutedExportsExpression(fn, wrapperExecution) {
  const moduleObjectNames = collectCreatedModuleObjectNames(fn, wrapperExecution);
  const exportsArguments = wrapperExecutionArguments(wrapperExecution).filter(isExportsMember);

  const createdModuleExports = exportsArguments.find((arg) =>
    moduleObjectNames.has(exportsObjectName(arg)),
  );
  if (createdModuleExports) return createdModuleExports;

  return exportsArguments[0] || null;
}

function functionName(node) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  return null;
}

function isFunctionLike(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function getReturnExportsExpression(fn) {
  let result = null;

  walk(fn.body, (node) => {
    if (result || node.type !== "ReturnStatement" || !node.argument) return;

    if (isExportsMember(node.argument)) {
      result = node.argument;
      return;
    }

    if (node.argument.type === "SequenceExpression") {
      const expressions = node.argument.expressions;
      const last = expressions[expressions.length - 1];
      if (isExportsMember(last)) result = last;
    }
  });

  return result;
}

function containsSelfReference(node, name) {
  let found = false;
  walk(node, (child) => {
    if (isIdentifier(child, name)) found = true;
  });
  return found;
}

function isWrapperExecutionCall(node, requireName) {
  if (!node || node.type !== "CallExpression") return false;

  const argsContainExports = node.arguments.some(isExportsMember);
  const argsContainRequire = node.arguments.some((arg) => isIdentifier(arg, requireName));
  const hasEnoughArgs = node.arguments.length >= 2;

  if (!hasEnoughArgs || !argsContainExports || !argsContainRequire) return false;

  if (
    node.callee.type === "MemberExpression" &&
    memberPropertyName(node.callee) === "call"
  ) {
    return true;
  }

  return node.callee.type === "CallExpression" || node.callee.type === "MemberExpression";
}

function findWrapperExecution(fn, requireName) {
  let best = null;

  walk(fn.body, (node, parent) => {
    if (best || !isWrapperExecutionCall(node, requireName)) return;
    best = { node, parent };
  });

  return best;
}

function scoreWebpackRequire(fn) {
  const name = functionName(fn);
  if (!name || fn.params.length !== 1) return null;

  const moduleIdParam = fn.params[0];
  if (!isIdentifier(moduleIdParam)) return null;

  const returnExports = getReturnExportsExpression(fn);
  const wrapperExecution = findWrapperExecution(fn, name);
  let moduleObjectLiteralCount = 0;
  let selfRefs = 0;

  walk(fn.body, (node) => {
    if (isModuleObjectLiteral(node)) moduleObjectLiteralCount++;
    if (isIdentifier(node, name)) selfRefs++;
  });

  let score = 0;
  if (returnExports) score += 5;
  if (wrapperExecution) score += 8;
  if (moduleObjectLiteralCount > 0) score += 4;
  score += Math.min(countExportsMembers(fn.body), 8);
  if (selfRefs > 0) score += 2;

  if (score < 14 || !returnExports || !wrapperExecution) return null;

  return {
    kind: "webpack-require-function",
    score,
    fn,
    requireName: name,
    moduleIdName: moduleIdParam.name,
    returnExports,
    wrapperExecution,
  };
}

function findWebpackRequireFunction() {
  const candidates = [];

  walk(ast, (node) => {
    if (!isFunctionLike(node)) return;
    const candidate = scoreWebpackRequire(node);
    if (candidate) candidates.push(candidate);
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function storagePrelude() {
  return [
    "window.varStorage = window.varStorage || {};",
    "window.varStorage.modules = window.varStorage.modules || {};",
  ].join("\n");
}

function captureStatement(moduleIdName, exportsExpression) {
  return `if (typeof window !== "undefined") {\n${storagePrelude()}\nwindow.varStorage.modules[${moduleIdName}] = ${exportsExpression};\n}`;
}

function patchRequireFunction(candidate) {
  const { fn, moduleIdName, returnExports, wrapperExecution } = candidate;
  const executedExports = getExecutedExportsExpression(fn, wrapperExecution.node) || returnExports;
  const capture = captureStatement(moduleIdName, nodeCode(executedExports));

  if (code.slice(fn.start, fn.end).includes("window.varStorage.modules")) {
    return {
      changed: false,
      reason: "require function already appears to be instrumented",
    };
  }

  const parent = wrapperExecution.parent;

  if (
    parent &&
    parent.type === "SequenceExpression" &&
    parent.expressions.includes(wrapperExecution.node)
  ) {
    const returnStatement = findEnclosingReturn(fn.body, parent);
    if (returnStatement && returnStatement.argument === parent) {
      const statements = parent.expressions
        .slice(0, -1)
        .map((expr) => `${nodeCode(expr)};`)
        .join("\n");
      const last = parent.expressions[parent.expressions.length - 1];
      const sequenceExports = getExecutedExportsExpression(fn, wrapperExecution.node) || last;
      const sequenceCapture = captureStatement(moduleIdName, nodeCode(sequenceExports));
      const correctedReplacement = `${statements}\n${sequenceCapture}\nreturn ${nodeCode(last)};`;
      return {
        changed: true,
        patched:
          code.slice(0, returnStatement.start) +
          correctedReplacement +
          code.slice(returnStatement.end),
      };
    }
  }

  const expressionStatement = findEnclosingExpressionStatement(fn.body, wrapperExecution.node);
  if (expressionStatement) {
    return {
      changed: true,
      patched:
        code.slice(0, expressionStatement.end) +
        `\n${capture}` +
        code.slice(expressionStatement.end),
    };
  }

  const returnStatement = findEnclosingReturn(fn.body, wrapperExecution.node);
  if (returnStatement) {
    const replacement = `${nodeCode(wrapperExecution.node)};\n${capture}\nreturn ${nodeCode(
      returnExports,
    )};`;
    return {
      changed: true,
      patched:
        code.slice(0, returnStatement.start) +
        replacement +
        code.slice(returnStatement.end),
    };
  }

  return {
    changed: false,
    reason: "found require function, but could not find a safe insertion point",
  };
}

function findEnclosingReturn(root, target) {
  let result = null;
  walk(root, (node) => {
    if (result || node.type !== "ReturnStatement") return;
    if (target.start >= node.start && target.end <= node.end) result = node;
  });
  return result;
}

function findEnclosingExpressionStatement(root, target) {
  let result = null;
  walk(root, (node) => {
    if (result || node.type !== "ExpressionStatement") return;
    if (target.start >= node.start && target.end <= node.end) result = node;
  });
  return result;
}

function findAsyncChunkRegistrations() {
  const registrations = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;

    const callee = node.callee;
    if (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "push" &&
      node.arguments.length > 0
    ) {
      const target = nodeCode(callee.object);
      if (/webpack|chunk|jsonp/i.test(target)) {
        registrations.push({
          kind: "chunk-push",
          target,
          start: node.start,
          end: node.end,
        });
      }
    }
  });

  return registrations;
}

function getDirectRequire(decl) {
  const init = decl.init;
  if (
    decl.id.type !== "Identifier" ||
    !init ||
    init.type !== "CallExpression" ||
    init.callee.type !== "Identifier" ||
    init.arguments.length !== 1 ||
    !isLiteralModuleId(init.arguments[0])
  ) {
    return null;
  }

  return {
    localName: decl.id.name,
    requireName: init.callee.name,
    moduleId: init.arguments[0].value,
  };
}

function getDefaultWrapper(decl) {
  const init = decl.init;
  if (
    decl.id.type !== "Identifier" ||
    !init ||
    init.type !== "CallExpression" ||
    init.callee.type !== "MemberExpression" ||
    init.callee.computed ||
    init.callee.object.type !== "Identifier" ||
    init.callee.property.type !== "Identifier" ||
    init.callee.property.name !== "n" ||
    init.arguments.length !== 1 ||
    init.arguments[0].type !== "Identifier"
  ) {
    return null;
  }

  return {
    localName: decl.id.name,
    requireName: init.callee.object.name,
    wrappedName: init.arguments[0].name,
  };
}

function scoreEntryDeclaration(rawRequires, wrappers) {
  if (rawRequires.length === 0) return 0;

  const rawNames = new Set(rawRequires.map((item) => item.localName));
  const wrapperMatches = wrappers.filter((item) => rawNames.has(item.wrappedName));
  const requireNames = new Set(rawRequires.map((item) => item.requireName));

  let score = rawRequires.length * 2 + wrapperMatches.length * 3;
  if (requireNames.size === 1) score += 3;
  if (rawRequires.length >= 2) score += 2;
  if (wrapperMatches.length >= 1) score += 2;

  return score;
}

function findEntryRequireDeclaration() {
  const candidates = [];

  walk(ast, (node) => {
    if (node.type !== "VariableDeclaration") return;

    const rawRequires = [];
    const wrappers = [];

    for (const decl of node.declarations) {
      const direct = getDirectRequire(decl);
      if (direct) rawRequires.push(direct);

      const wrapper = getDefaultWrapper(decl);
      if (wrapper) wrappers.push(wrapper);
    }

    const score = scoreEntryDeclaration(rawRequires, wrappers);
    if (score > 0) {
      candidates.push({ node, rawRequires, wrappers, score });
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchEntryDeclarationFallback() {
  const candidate = findEntryRequireDeclaration();
  if (!candidate || candidate.rawRequires.length === 0) {
    return { changed: false, reason: "no Webpack entry require declaration found" };
  }

  const lookahead = code.slice(candidate.node.end, candidate.node.end + 2000);
  const lines = ["", "window.varStorage = window.varStorage || {};"];
  const exposed = [];

  for (const item of candidate.rawRequires) {
    const alreadyExposed = new RegExp(
      `window\\.varStorage\\.${escapeRegExp(item.localName)}\\s*=`,
    ).test(lookahead);

    if (alreadyExposed) continue;

    lines.push(`window.varStorage.${item.localName} = ${item.localName};`);
    exposed.push(item);
  }

  if (exposed.length === 0) {
    return {
      changed: false,
      reason: "entry require variables already appear to be exposed",
    };
  }

  return {
    changed: true,
    exposed,
    candidate,
    patched:
      code.slice(0, candidate.node.end) +
      `${lines.join("\n")}\n` +
      code.slice(candidate.node.end),
  };
}

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

function instrumentJavaScript(source, options = {}) {
  code = String(source);
  let parsedSourceType = options.sourceType || "script";
  try {
    ast = parseJavaScript(code, options);
  } catch (error) {
    if (!options.sourceType) {
      try {
        parsedSourceType = "module";
        ast = parseJavaScript(code, { ...options, sourceType: "module" });
      } catch (moduleError) {
        if (options.throwOnParseError) throw moduleError;

        const metadata = metadataBase(options, []);
        metadata.parseError = moduleError.message;
        metadata.warnings.push(`Parse failed: ${moduleError.message}`);
        return {
          code,
          changed: false,
          metadata,
        };
      }
    } else {
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
  }

  const asyncRegistrations = findAsyncChunkRegistrations();
  const metadata = metadataBase(options, asyncRegistrations);
  metadata.sourceType = parsedSourceType;
  const requireCandidate = findWebpackRequireFunction();

  if (requireCandidate) {
    const result = patchRequireFunction(requireCandidate);
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

  const fallback = patchEntryDeclarationFallback();
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

  metadata.warnings.push(
    requireCandidate
      ? `Fallback detector note: ${fallback.reason}`
      : `Fallback detector note: ${fallback.reason}`,
  );
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

function logCliResult(outputFile, result) {
  const metadata = result.metadata || {};

  if (result.changed) {
    console.log(`Patched ${outputFile}`);
    if (metadata.webpackPattern === "require-cache-wrapper") {
      console.log(
        `Instrumented Webpack require function "${metadata.requireName}" to capture module exports.`,
      );
      console.log(`Module id parameter: ${metadata.moduleIdParameter}`);
    } else if (metadata.webpackPattern === "entry-require-globalization") {
      console.log("Fell back to entry require variable globalization.");
      for (const item of metadata.exposedEntryRequires || []) {
        console.log(`- ${item.localName} = ${item.requireName}(${item.moduleId})`);
      }
    }

    if (metadata.asyncChunkRegistrations && metadata.asyncChunkRegistrations.length > 0) {
      console.log("Detected async chunk registration sites:");
      for (const item of metadata.asyncChunkRegistrations) {
        console.log(`- ${item.kind}: ${item.target}`);
      }
    }
    return;
  }

  console.error("Could not instrument this bundle.");
  for (const warning of metadata.warnings || []) {
    console.error(warning);
  }
  if (metadata.asyncChunkRegistrations && metadata.asyncChunkRegistrations.length > 0) {
    for (const item of metadata.asyncChunkRegistrations) {
      console.error(`- ${item.kind}: ${item.target}`);
    }
  }
}

function cliMain(argv) {
  const [inputFile, outputFile = inputFile] = argv;

  if (!inputFile) {
    console.error("Usage: node globalize-library.js <source.js> [output.js]");
    return 1;
  }

  const result = instrumentFile(inputFile, outputFile);
  logCliResult(outputFile, result);
  return result.changed ? 0 : 2;
}

module.exports = {
  instrumentJavaScript,
  instrumentFile,
  acornEcmaVersion,
};

if (require.main === module) {
  process.exitCode = cliMain(process.argv.slice(2));
}
