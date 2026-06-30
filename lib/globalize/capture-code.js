// Snippets inserted into matched Webpack runtime code. The instrumentation is
// intentionally small: it only mirrors module exports into an observation object
// and does not change the value returned to the application.

function storagePrelude() {
  return [
    "window.varStorage = window.varStorage || {};",
    "window.varStorage.modules = window.varStorage.modules || {};",
  ].join("\n");
}

function captureStatement(moduleIdName, exportsExpression) {
  return `if (typeof window !== "undefined") {\n${storagePrelude()}\nwindow.varStorage.modules[${moduleIdName}] = ${exportsExpression};\n}`;
}

module.exports = {
  storagePrelude,
  captureStatement,
};
