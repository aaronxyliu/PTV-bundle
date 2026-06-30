const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function csvEscape(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvHeaders() {
  return [
    "rank",
    "domain",
    "url",
    "baseline_status",
    "instrumented_status",
    "baseline_final_url",
    "instrumented_final_url",
    "baseline_library_count",
    "instrumented_library_count",
    "new_library_count",
    "scripts_seen",
    "scripts_instrumented",
    "scripts_failed",
    "baseline_detected_json",
    "instrumented_detected_json",
    "new_libraries_json",
    "baseline_error",
    "instrumented_error",
  ];
}

function csvRow(record) {
  return [
    record.rank,
    record.domain,
    record.url,
    record.baseline.status,
    record.instrumented.status,
    record.baseline.final_url,
    record.instrumented.final_url,
    record.baseline.detected.length,
    record.instrumented.detected.length,
    record.new_libraries.length,
    record.instrumentation.scripts_seen,
    record.instrumentation.scripts_instrumented,
    record.instrumentation.scripts_failed,
    record.baseline.detected,
    record.instrumented.detected,
    record.new_libraries,
    record.baseline.error,
    record.instrumented.error,
  ].map(csvEscape).join(",");
}

function prepareOutputs(args) {
  for (const file of [args.output, args.outputCsv]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  if (!args.append) {
    fs.writeFileSync(args.output, "");
    fs.writeFileSync(args.outputCsv, `${csvHeaders().join(",")}\n`);
  } else if (!fs.existsSync(args.outputCsv) || fs.statSync(args.outputCsv).size === 0) {
    fs.writeFileSync(args.outputCsv, `${csvHeaders().join(",")}\n`);
  }
}

function appendCsv(file, record) {
  fs.appendFileSync(file, `${csvRow(record)}\n`);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function importToDatabase(args, projectRoot = path.join(__dirname, "..")) {
  if (!args.database) return;

  const result = spawnSync(
    "python3",
    [
      path.join("scripts", "import_pair_results.py"),
      "--input",
      args.output,
      "--database",
      args.database,
      "--table-prefix",
      args.tablePrefix,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Database import failed with exit code ${result.status}`);
  }
}

module.exports = {
  csvEscape,
  csvHeaders,
  csvRow,
  prepareOutputs,
  appendCsv,
  appendJsonl,
  importToDatabase,
};
