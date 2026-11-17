#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Session } from "./browser.js";
import { serveStdio } from "./mcp.js";
import { loadPolicy } from "./policy.js";

const USAGE = `local-browser: a safe, token-lean local browser for AI agents

Usage:
  local-browser mcp [options]             Run the MCP server on stdio
  local-browser snapshot <url> [options]  Print a compact snapshot of a page

Options:
  --policy <file>     Policy JSON (allowedDomains, blockedDomains, confirm, maxSnapshotChars)
  --browser <name>    chrome (default) or msedge: the browser installed on this machine
  --headless          No window; steps that need approval are denied
  -h, --help          Show this help

Profile and action log live in $LOCAL_BROWSER_HOME (default ~/.local-browser).
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      policy: { type: "string" },
      browser: { type: "string", default: "chrome" },
      headless: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  const home = resolve(process.env.LOCAL_BROWSER_HOME || join(homedir(), ".local-browser"));
  const opts = () => ({
    policy: loadPolicy(values.policy),
    profileDir: join(home, "profile"),
    logFile: join(home, "actions.jsonl"),
    channel: values.browser,
    headless: values.headless,
  });

  const [cmd, url] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
  } else if (cmd === "mcp") {
    await serveStdio(opts());
  } else if (cmd === "snapshot" && url) {
    const s = await Session.launch({ ...opts(), headless: true });
    try {
      await s.open(url);
      console.log(await s.snapshot());
    } finally {
      await s.close();
    }
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

// bad flags, a broken policy file or a missing browser should read as one line, not a stack trace
main().catch((e) => {
  console.error(`local-browser: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  process.exitCode = 1;
});
