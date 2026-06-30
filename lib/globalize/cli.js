const { instrumentFile } = require("./instrumenter.js");

// CLI output is intentionally human-readable. Machine-readable metadata is
// returned by instrumentJavaScript and captured in crawl JSONL records.

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
  logCliResult,
  cliMain,
};
