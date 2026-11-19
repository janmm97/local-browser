# local-browser

[![CI](https://github.com/janmm97/local-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/janmm97/local-browser/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933)

local-browser is a browser MCP server and CLI for AI agents. It drives the Chrome or Edge already on your machine, with compact text snapshots instead of raw HTML and human approval before form submits.

**Who it's for:** people who connect Claude Code or another MCP client to a real browser and want fewer characters per page and a person approving form submits.

> **Status: v0.1, early.** Works, but expect rough edges. Feedback welcome in Issues.

## Why local-browser
Agents waste tokens on raw HTML, and handing them your everyday browser profile is risky. local-browser:

- **runs your installed Chrome/Edge with a separate profile**, so no cookies or saved passwords from your normal browsing;
- **shows the agent compact text snapshots** with numbered refs instead of HTML;
- **waits for a human "yes"** in the browser before submitting forms or typing into password fields;
- **keeps to a domain policy** (allow/block lists, `http(s)` only, re-checked after redirects);
- **logs every action** to a local JSONL file, with typed text redacted.

## Requirements
- Node.js 22+
- Google Chrome or Microsoft Edge
- Windows or Linux, tested in CI. macOS should work but isn't tested in CI yet. No GPU needed.

## Quick start
```sh
git clone https://github.com/janmm97/local-browser
cd local-browser
npm ci
npm run build
node dist/cli.js snapshot https://en.wikipedia.org/wiki/Web_browser
```

### Use it from Claude Code (or any MCP client)
```sh
claude mcp add local-browser -- node /path/to/local-browser/dist/cli.js mcp
```
Other clients: run `node /path/to/local-browser/dist/cli.js mcp` as a stdio server. The browser window opens on the first tool call.

## Usage
```
local-browser mcp [options]             Run the MCP server on stdio
local-browser snapshot <url> [options]  Print a compact snapshot of a page

  --policy <file>     Policy JSON
  --browser <name>    chrome (default) or msedge
  --headless          No window; steps that need approval are denied
```
The profile and action log live in `~/.local-browser/` (`profile/`, `actions.jsonl`). Set `LOCAL_BROWSER_HOME` to move them.

### MCP tools
| Tool | What it does |
|---|---|
| `open(url)` | Go to a URL (checked against the policy) |
| `snapshot()` | Compact page outline: `[ref] role "name"` plus headings and text |
| `click(ref)` | Click an element; submit buttons wait for approval |
| `type(ref, text, submit?)` | Fill a field; password fields and `submit` wait for approval |
| `scroll(up\|down)` | Scroll the page |
| `back()` | Go back |
| `screenshot()` | JPEG of the viewport (costs far more tokens than a snapshot) |
| `ask_human(reason)` | Hand the browser to you for a step only a person should do (CAPTCHA, "press and hold" bot check, 2FA), then carry on in the same session |

A snapshot looks like:
```
# Hacker News
url: https://news.ycombinator.com/
[2] link "Hacker News"
[3] link "new"
...
```

### Bot checks and CAPTCHAs
local-browser does **not** solve or get around CAPTCHAs or bot checks: you do them, and every agent carries on by itself.

**Automatic wait (headed, on by default).** When `open`, `click`, `type` or `back` lands on a bot check or CAPTCHA, local-browser brings that tab to the front with a yellow notice at the bottom and waits. You complete the check (for example Skyscanner's "press and hold"); once it's gone, the step returns as usual and the agent carries on, with no tool call from the agent. It waits up to 10 minutes, then the step is denied. It recognises reCAPTCHA, hCaptcha, Cloudflare (Turnstile and "Just a moment"), HUMAN/PerimeterX press-and-hold, DataDome, Arkose/FunCaptcha, AWS WAF, GeeTest, Friendly Captcha and Google's "unusual traffic" page. The profile keeps its cookies, so a site you've passed once usually asks less often.

**`ask_human`, for anything else.** With `--headless` (or a check it doesn't recognise) a snapshot adds a line telling the agent to call `ask_human`. Then:

1. A local tab opens with the agent's reason and **Done** / **Give up** buttons.
2. You switch to the page's tab and do the check yourself (it's your real input, in the same browser session).
3. You click **Done**. The agent gets a fresh snapshot and carries on with the same cookies.

While you have the browser (in both cases), a form submit goes through without an approval prompt only within 3 seconds of your own real click or key press, so an ordinary page doesn't send forms on its own while you take your time (one it sends in those 3 seconds after your click still passes). This is best effort, not a security boundary: a hostile page can get around it, as it can send data with `fetch()` anyway. During the automatic wait, a POST back to the check page's own site also passes, because Cloudflare challenges finish that way. The domain policy still applies. Only click **Done** after the check, and **Give up** if the agent asks for something you did not expect. The agent waits up to 10 minutes (some MCP clients time out tool calls sooner; if yours does, finish the check and ask the agent to take a snapshot). `ask_human` needs a visible window, so it's refused with `--headless`.

### Domain policy
Copy [`local-browser.policy.example.json`](local-browser.policy.example.json) and pass it with `--policy`:
```json
{
  "allowedDomains": ["wikipedia.org", "news.ycombinator.com"],
  "blockedDomains": ["accounts.google.com"],
  "confirm": ["submit", "password"],
  "maxSnapshotChars": 12000
}
```
- `allowedDomains`: if not empty, only these domains and their subdomains can be visited.
- `blockedDomains`: never visited.
- `confirm`: steps that need a human click on **Allow** in a separate browser tab. Scripted clicks don't count. Remove a step from the list to let it run without asking.
- `maxSnapshotChars`: longer snapshots are cut (the agent can scroll).

Unknown keys are rejected, so a typo can't silently turn a rule off.

## How many tokens does it save?
Measured on 2026-11-18 (Windows 11, Chrome), characters of raw HTML against a full, uncapped snapshot:

| Page | HTML | Snapshot | Smaller by |
|---|---|---|---|
| en.wikipedia.org/wiki/Web_browser | 413,306 | 31,397 | ~13× |
| news.ycombinator.com | 34,365 | 10,553 | ~3× |

With the default `maxSnapshotChars` (12,000) the Wikipedia snapshot is cut to about 12 KB.

## How local-browser compares
What each tool does by default, from each project's own documentation. Checked 2026-11-20. "Not stated" means the pages checked do not say; the tool may still do it.

| Tool | Browser and profile | What the model receives | Human approval before submit or password | Domain allow/block policy |
|---|---|---|---|---|
| local-browser (v0.1) | Your installed Chrome or Edge, with a separate profile in `~/.local-browser/profile` | Compact text snapshot with numbered refs; `screenshot()` is optional | Yes: a click on **Allow** in a separate tab for POST form submits and `type="password"` fields (`confirm` setting; see Known limits) | Yes: `allowedDomains` / `blockedDomains` (navigations only, see Known limits) |
| Playwright MCP (Microsoft) | Headed by default; login state and cookies kept between sessions by default; Chrome, Firefox, WebKit and Edge listed. Other profile options: not checked | Accessibility snapshot ("not pixels"); screenshot tool also listed | Not stated | Not stated |
| Browser MCP | Your own Chrome or other Chromium browser, through an extension ("Agents use your browser profile") | Snapshot on request (`snapshot -i`), plus `find`, `get text`, `screenshot`; each action answers with one line | A one-time pairing code and **Allow** click; no per-submit approval stated | Not stated; incognito tabs and browser pages such as chrome://settings are listed as off limits |
| Browser Use | Local mode uses the Chrome, Chromium or Edge you have installed; its example comment says "a fresh local Chrome with a temp profile". Default run uses a Cloud browser | Not stated | Not stated | Not stated for local use; Cloud API has `allowedDomains` for secret bindings only |

Sources (all read 2026-11-20): [Playwright MCP](https://playwright.dev/mcp/introduction), [Browser MCP](https://browsermcp.io), [Browser Use docs](https://docs.browser-use.com/introduction) and [its open-source quickstart](https://docs.browser-use.com/open-source/quickstart). local-browser column: this README. Playwright MCP's profile and domain options are not checked here. Spotted an error? Open an issue.

## Known limits (v0.1)
- The domain policy applies to page navigations, not to images, scripts or other subresources a page loads.
- Redirects aren't checked while they happen: a redirected request (including a 307/308 re-POST of an approved form) is still sent; the agent is then taken off a blocked page.
- Iframes aren't included in snapshots.
- No downloads (they're turned off), uploads or tab-switching tool.
- "Submit" approval: a click on a submit button (including `<button form=…>`) or Enter via `type` waits for a human. The approval lets one form **POST** through, only to the target shown in the prompt; every other POST navigation is blocked, so page-JavaScript `form.submit()` can't send data. Not covered: `fetch`/XHR requests, and forms that submit with GET. Use `allowedDomains` for sites you don't trust.
- Localhost and private network addresses (and the cloud metadata IP 169.254.169.254) are **not** blocked by default. `blockedDomains` matches host names and exact addresses only (for example `localhost`, `127.0.0.1`, `[::1]`, `169.254.169.254`), not ranges like `10.0.0.0/8`; list the ones you need. Range blocking is planned for v0.2 ([#7](https://github.com/janmm97/local-browser/issues/7)).
- Page text is untrusted: a page can hide instructions in invisible text that still appears in snapshots. The tool descriptions tell the model not to follow them, which is a hint, not a guarantee.
- Password approval only fires for fields that are `type="password"` when the agent types; a page can use a plain text field for a password.
- Approval needs a visible window; in `--headless` mode those steps are denied.
- The log stores URLs, which can contain query text a site puts there (for example search forms).
- `data-lb-ref` attributes are visible to page scripts. They are labels, not a security boundary.
- CI tests the approval prompt headless (including a hostile button label); the full headed flow is a manual check (`npm run build && node test/approval.manual.mjs`).

## FAQ

### What is local-browser?
local-browser is an MCP browser server and command-line tool for AI agents. It drives the Google Chrome or Microsoft Edge already installed on your machine, gives the agent compact text snapshots with numbered refs instead of raw HTML, and waits for a human to approve form submits and typing into password fields. It is v0.1 software, requires Node.js 22+, and is licensed under MIT.

### How do I add local-browser to Claude Code or another MCP client?
Clone the repository, run `npm ci` and `npm run build`, then run `claude mcp add local-browser -- node /path/to/local-browser/dist/cli.js mcp`. Other MCP clients can run the same `node /path/to/local-browser/dist/cli.js mcp` command as a stdio server. local-browser opens its browser window on the first tool call. Chrome is the default; pass `--browser msedge` for Edge.

### Does local-browser use my everyday browser profile or passwords?
No. local-browser runs your installed Chrome or Edge with its own separate profile, stored in `~/.local-browser/profile` (move it with `LOCAL_BROWSER_HOME`), so the agent gets no cookies or saved passwords from your normal browsing. That separate profile keeps its own cookies between runs. The action log stores URLs, which can contain query text, and redacts typed text.

### Can local-browser solve CAPTCHAs?
No. local-browser does not solve or get around CAPTCHAs or bot checks. When it recognises one in a visible window, it brings that tab to the front and waits up to 10 minutes while you complete it, then the agent carries on. For a check it does not recognise, the agent can call `ask_human` to hand you the browser. Both need a visible window; `--headless` denies those steps.

### How many tokens do snapshots save compared with raw HTML?
Measured on 2026-11-18 on Windows 11 with Chrome, local-browser's full snapshot of en.wikipedia.org/wiki/Web_browser was 31,397 characters against 413,306 characters of raw HTML, about 13× smaller. For news.ycombinator.com it was 10,553 against 34,365, about 3× smaller. These are character counts, not model tokens, and the default `maxSnapshotChars` (12,000) cuts longer snapshots.

### What does the domain policy and approval step not protect against?
local-browser's domain policy applies to page navigations, not to images, scripts or other subresources, and its submit approval does not cover `fetch`/XHR requests or forms that submit with GET. Localhost and private network addresses are not blocked by default, and page text is untrusted, so a page can hide instructions in snapshots. See [Known limits (v0.1)](#known-limits-v01).

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security
See [SECURITY.md](SECURITY.md). Don't open public issues for vulnerabilities.

## License
MIT, see [LICENSE](LICENSE).
