# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `ask_human(reason)` tool: hands the browser to the user for a CAPTCHA, a bot check or 2FA, waits for **Done**, then returns a fresh snapshot. Form submits go through during the handoff only within 3 seconds of the user's own real click or key press.
- Snapshots add a note when the page shows a known bot check or CAPTCHA (visible reCAPTCHA, hCaptcha, Cloudflare Turnstile, HUMAN/PerimeterX "press and hold"; not invisible badges or long articles), telling the agent to call `ask_human` rather than try to solve it.

## [0.1.0] - 2026-11-18

### Security
- Policy domains are normalised (case, punycode, trailing dot, `*.`) and a non-domain entry such as `https://evil.com` is now an error instead of silently never matching.
- Form POST navigations are blocked unless a human approved the click or Enter that caused them (closes page-JS `form.submit()`); `<button form=…>` counts as a submit; the approval prompt shows the real form target; a button swapped while the prompt is open is refused; service workers are blocked so every request is checked.
- Log folder is created `0700` and the log `0600` (not enforced on Windows).
- Tool descriptions mark page text as untrusted.

### Fixed
- MCP: a failed browser launch or a closed window no longer breaks every later call; errors are one short line with a hint when Chrome/Edge is missing; the server reports the package version.
- CLI: bad options, a broken policy file or a missing browser print one `local-browser: …` line and exit non-zero; `LOCAL_BROWSER_HOME` is made absolute.
- CI: `npm audit` for runtime dependencies, concurrency group; Dependabot for npm and GitHub Actions.

### Added
- Project scaffold: MIT licence, docs, issue/PR templates, CI on Linux and Windows.
- Policy file (`allowedDomains`, `blockedDomains`, `confirm`, `maxSnapshotChars`) with strict validation; only `http(s)` and `about:blank` URLs are allowed.
- JSONL action log with password redaction.
- Browser session over the installed Chrome/Edge with an isolated profile: `open`, `snapshot`, `click`, `type`, `scroll`, `back`, `screenshot`. Downloads are off.
- Compact snapshots: numbered refs for visible interactive elements plus headings and text; password values never shown.
- Approval prompt: form submits and password typing wait for a human click in a separate browser tab (untrusted, scripted clicks don't count; page text is shown as text only and the decision is kept outside the page; the buttons only work after 1 second, so a stray click can't approve). An approval lets exactly one form POST through, and only to the target the human was shown. Headless mode denies them.
- Domain policy enforced on every navigation, and re-checked after each action, so the agent can't stay on a blocked page after a redirect (the redirected request itself is still sent).
- MCP server on stdio (`local-browser mcp`) with the tools `open`, `snapshot`, `click`, `type`, `scroll`, `back`, `screenshot`; the browser opens on the first call.
- `local-browser snapshot <url>` CLI command, `--policy`, `--browser`, `--headless`, `LOCAL_BROWSER_HOME`.
- README usage, Claude Code setup, example policy and measured snapshot sizes.

[Unreleased]: https://github.com/janmm97/local-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/janmm97/local-browser/releases/tag/v0.1.0
