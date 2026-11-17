// Manual check of ask_human in a headed browser (needs a display, so not part of CI): npm run build && node test/handoff.manual.mjs
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../dist/browser.js";
import { loadPolicy } from "../dist/policy.js";

const http = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>${req.method} ${req.url}</title><form method=post action="/again"><input name=q><button>Go</button></form>`));
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${http.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "lb-handoff-"));
const s = await Session.launch({
  policy: loadPolicy(),
  profileDir: join(dir, "profile"),
  logFile: join(dir, "log.jsonl"),
  channel: process.env.LOCAL_BROWSER_CHANNEL ?? "chrome",
  headless: false,
  handoffTimeoutMs: 15_000,
  approvalTimeoutMs: 8_000,
});
const ctx = s.context;
await s.page.goto(base);
await s.page.setContent(`<form method=post action="${base}/done"><input name=q><button>Verify</button></form>`);

// the "human" submits the form while they have the browser, then clicks Done: the POST must go through
ctx.once("page", async (prompt) => {
  await s.page.click("button"); // a human submit during the handoff
  await prompt.waitForSelector("#allow:enabled");
  await prompt.click("#allow");
});
console.log("handoff + human submit:", await s.handoff("Solve the check").then((r) => (r.startsWith("# POST /done") ? "ok (good): the human's POST went through" : `BLOCKED (bad): ${r.split("\n")[0]}`), (e) => `FAILED (bad): ${e.message}`));

// after the handoff an agent submit needs approval again (headed, nobody answers: times out)
await s.snapshot();
console.log("agent submit after:", await s.click(2).then(() => "ALLOWED (bad)", (e) => `denied (good): ${e.message}`));
await s.close();
http.close();
