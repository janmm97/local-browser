# local-browser

A safe, token-lean local browser for AI agents: a CLI and MCP server that drives the Chrome or Edge already on your machine.

> **Status: v0.1, early.** Works, but expect rough edges. Feedback welcome in Issues.

## Why
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
local-browser does **not** solve or get around CAPTCHAs or bot checks. Those are a site's access control. When a snapshot shows one, it adds a line telling the agent to call `ask_human`. Then:

1. A local tab opens with the agent's reason and **Done** / **Give up** buttons.
2. You switch to the page's tab and do the check yourself (it's your real input, in the same browser session).
3. You click **Done**. The agent gets a fresh snapshot and carries on with the same cookies.

While you have the browser, a form submit goes through without an approval prompt only within 3 seconds of your own real click or key press, so a page can't send forms on its own while you take your time (one it sends in those 3 seconds after your click still passes). The domain policy still applies. Only click **Done** after the check, and **Give up** if the agent asks for something you did not expect. The agent waits up to 10 minutes (some MCP clients time out tool calls sooner; if yours does, finish the check and ask the agent to take a snapshot). `ask_human` needs a visible window, so it's refused with `--headless`.

### Policy
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

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security
See [SECURITY.md](SECURITY.md). Don't open public issues for vulnerabilities.

## License
MIT, see [LICENSE](LICENSE).
