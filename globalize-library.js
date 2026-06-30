#!/usr/bin/env node

// Public entrypoint for JavaScript bundle globalization.
//
// The implementation lives in lib/globalize/ so the parsing, Webpack pattern
// detection, source patching, and CLI reporting can evolve independently. This
// wrapper keeps the original require path and npm bin stable:
//
//   const { instrumentJavaScript } = require("./globalize-library.js")
//   node globalize-library.js input.js output.js

const {
  acornEcmaVersion,
  instrumentFile,
  instrumentJavaScript,
  metadataBase,
  parseWithFallback,
} = require("./lib/globalize/instrumenter.js");
const { cliMain, logCliResult } = require("./lib/globalize/cli.js");

module.exports = {
  instrumentJavaScript,
  instrumentFile,
  acornEcmaVersion,
  metadataBase,
  parseWithFallback,
  cliMain,
  logCliResult,
};

if (require.main === module) {
  process.exitCode = cliMain(process.argv.slice(2));
}
