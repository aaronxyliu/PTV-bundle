// Snippets inserted into matched Webpack runtime code. The instrumentation is
// intentionally small: it only mirrors module exports into an observation object
// and does not change the value returned to the application.

function storagePrelude() {
  return [
    "window.varStorage = window.varStorage || {};",
    "window.varStorage.modules = window.varStorage.modules || {};",
    "window.varStorage.moduleLocations = window.varStorage.moduleLocations || {};",
  ].join("\n");
}

function captureStatement(moduleIdName, exportsExpression, location = {}) {
  const locationJson = JSON.stringify(location);
  return `if (typeof window !== "undefined") {\n${storagePrelude()}\nwindow.varStorage.modules[${moduleIdName}] = ${exportsExpression};\nwindow.varStorage.moduleLocations[${moduleIdName}] = Object.assign({ module_id: String(${moduleIdName}) }, ${locationJson});\n}`;
}

module.exports = {
  storagePrelude,
  captureStatement,
};
