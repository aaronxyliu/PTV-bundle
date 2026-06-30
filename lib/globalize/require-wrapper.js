const {
  countExportsMembers,
  findEnclosingExpressionStatement,
  findEnclosingReturn,
  functionName,
  isExportsMember,
  isFunctionLike,
  isIdentifier,
  isModuleObjectLiteral,
  memberPropertyName,
  nodeCode,
  unwrapModuleObjectInitializer,
  walk,
} = require("./ast-utils.js");
const { captureStatement } = require("./capture-code.js");

// Primary strategy: find Webpack's require/cache wrapper. In many bundles this
// function receives a module id, executes a factory, stores exports in a module
// cache, and returns module.exports. Capturing there exposes every initialized
// module export with the least duplication.

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

function findWebpackRequireFunction(ast) {
  const candidates = [];

  walk(ast, (node) => {
    if (!isFunctionLike(node)) return;
    const candidate = scoreWebpackRequire(node);
    if (candidate) candidates.push(candidate);
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function patchRequireFunction(code, candidate) {
  const { fn, moduleIdName, returnExports, wrapperExecution } = candidate;
  const executedExports = getExecutedExportsExpression(fn, wrapperExecution.node) || returnExports;
  const capture = captureStatement(moduleIdName, nodeCode(code, executedExports));

  if (code.slice(fn.start, fn.end).includes("window.varStorage.modules")) {
    return {
      changed: false,
      reason: "require function already appears to be instrumented",
    };
  }

  const parent = wrapperExecution.parent;

  // Minified runtimes often place factory execution inside a return sequence.
  // Convert that sequence into statements so the capture runs before the return.
  if (
    parent &&
    parent.type === "SequenceExpression" &&
    parent.expressions.includes(wrapperExecution.node)
  ) {
    const returnStatement = findEnclosingReturn(fn.body, parent);
    if (returnStatement && returnStatement.argument === parent) {
      const statements = parent.expressions
        .slice(0, -1)
        .map((expr) => `${nodeCode(code, expr)};`)
        .join("\n");
      const last = parent.expressions[parent.expressions.length - 1];
      const sequenceExports = getExecutedExportsExpression(fn, wrapperExecution.node) || last;
      const sequenceCapture = captureStatement(moduleIdName, nodeCode(code, sequenceExports));
      const correctedReplacement = `${statements}\n${sequenceCapture}\nreturn ${nodeCode(code, last)};`;
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
    const replacement = `${nodeCode(code, wrapperExecution.node)};\n${capture}\nreturn ${nodeCode(
      code,
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

module.exports = {
  findWebpackRequireFunction,
  patchRequireFunction,
  scoreWebpackRequire,
  getExecutedExportsExpression,
};
