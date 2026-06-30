# Contributing

Thanks for improving PTV-bundle. The project is intentionally small, so contributions are easiest to review when they are focused and reproducible.

## Development Setup

```bash
npm install
npm run setup:ptv
```

`npm run setup:ptv` clones PTV into `external/PTV`, which is ignored by git.

## Before Opening a Pull Request

Run the automated tests:

```bash
npm test
```

If your change affects browser crawling, also run a small manual crawl and write outputs outside the repository or under an ignored results directory:

```bash
npm run crawl -- \
  --url https://example.com/ \
  --headless new \
  --output /tmp/ptv-bundle-smoke.jsonl \
  --output-csv /tmp/ptv-bundle-smoke.csv
```

## Test Fixtures

The Webpack globalization tests generate blank applications in the OS temp directory. Do not commit generated bundles, crawl outputs, `external/PTV`, or local database files.

## Code Style

- Keep modules focused by responsibility.
- Prefer existing helper APIs over ad hoc parsing or string manipulation.
- Add comments where timing, Webpack runtime shape, or PTV interaction is not obvious.
- Preserve output field names unless a migration is intentional and documented.

## Reporting Issues

For bugs, include Node.js, Chrome/Chromium, PTV checkout details, the command you ran, and relevant JSONL or instrumentation logs.
