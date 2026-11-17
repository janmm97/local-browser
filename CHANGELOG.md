# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project scaffold: MIT licence, docs, issue/PR templates, CI on Linux and Windows.
- Policy file (`allowedDomains`, `blockedDomains`, `confirm`, `maxSnapshotChars`) with strict validation; only `http(s)` and `about:blank` URLs are allowed.
- JSONL action log with password redaction.
- Browser session over the installed Chrome/Edge with an isolated profile: `open`, `snapshot`, `click`, `type`, `scroll`, `back`, `screenshot`. Downloads are off.
- Compact snapshots: numbered refs for visible interactive elements plus headings and text; password values never shown.
- Approval prompt: form submits and password typing wait for a human click in a separate browser tab (untrusted, scripted clicks don't count; page text is shown as text only and the decision is kept outside the page; the buttons only work after 1 second, so a stray click can't approve). An approval lets exactly one form POST through, and only to the target the human was shown. Headless mode denies them.
- Domain policy enforced on every navigation, and re-checked after each action so redirects can't slip past.
