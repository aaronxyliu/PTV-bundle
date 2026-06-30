const acorn = require("acorn");

// This file contains syntax-only helpers shared by the Webpack detectors. The
// instrumentation avoids code generation libraries and instead splices original
// source ranges, so every helper here works directly with Acorn node positions.

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

function nodeCode(code, node) {
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

function functionName(node) {
  // Webpack runtimes may define the require wrapper either as
  // `function __webpack_require__(id) { ... }` or as a minified named function
  // expression such as `const n = function n(id) { ... }`.
  if (
    (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
    node.id
  ) {
    return node.id.name;
  }
  return null;
}

function isFunctionLike(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  acornEcmaVersion,
  parseJavaScript,
  walk,
  nodeCode,
  isIdentifier,
  isLiteralModuleId,
  memberPropertyName,
  isExportsMember,
  countExportsMembers,
  isModuleObjectLiteral,
  unwrapModuleObjectInitializer,
  functionName,
  isFunctionLike,
  findEnclosingReturn,
  findEnclosingExpressionStatement,
  escapeRegExp,
};
