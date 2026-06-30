# Security Policy

PTV-bundle is an academic/research tool for measuring JavaScript library detection behavior. It is not intended to bypass authentication, bot checks, paywalls, or access controls.

## Reporting Security Issues

Please do not open a public issue for a security-sensitive report. Instead, contact the repository maintainer through GitHub or by a private channel listed on the maintainer profile.

Include:

- affected commit or release;
- reproduction steps;
- impact assessment;
- any relevant crawl output or generated bundle, with secrets removed.

## Handling Crawl Data

Crawl outputs can include URLs, page-state diagnostics, detected library names/versions, and script instrumentation metadata. Treat outputs from non-public or sensitive sites as confidential.

## Responsible Use

- Only crawl sites you are authorized to analyze.
- Respect rate limits, robots policies where applicable, and legal constraints.
- Do not use this tool to evade logins, consent requirements, bot checks, or other access-control mechanisms.
