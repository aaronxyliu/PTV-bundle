const {
  escapeRegExp,
  isLiteralModuleId,
  memberPropertyName,
  nodeCode,
  walk,
} = require("./ast-utils.js");

// Fallback strategy: when the central require/cache wrapper is not recognizable,
// expose entry-level variables that are direct require(moduleId) calls. This is
// less complete than capturing every module export, but it still makes some
// bundled library roots visible to PTV.

function findAsyncChunkRegistrations(ast, code) {
  const registrations = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;

    const callee = node.callee;
    if (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "push" &&
      node.arguments.length > 0
    ) {
      const target = nodeCode(code, callee.object);
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

function findEntryRequireDeclaration(ast) {
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

function patchEntryDeclarationFallback(ast, code) {
  const candidate = findEntryRequireDeclaration(ast);
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

module.exports = {
  findAsyncChunkRegistrations,
  getDirectRequire,
  getDefaultWrapper,
  scoreEntryDeclaration,
  findEntryRequireDeclaration,
  patchEntryDeclarationFallback,
};
