// Manual check of the headed approval prompt (needs a display, so not part of CI): npm run build && node test/approval.manual.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../dist/browser.js";
import { loadPolicy } from "../dist/policy.js";

const dir = mkdtempSync(join(tmpdir(), "lb-approval-"));
const s = await Session.launch({
  policy: loadPolicy(),
  profileDir: join(dir, "profile"),
  logFile: join(dir, "log.jsonl"),
  channel: process.env.LOCAL_BROWSER_CHANNEL ?? "chrome",
  headless: false,
  approvalTimeoutMs: 15_000,
});
const ctx = s.context;
await s.open("data:text/html,x").catch(() => {}); // blocked scheme, stays on about:blank
await s.page.setContent(`<form action="about:blank"><input name=q><button>Go</button></form>`);
console.log(await s.snapshot());

// 1. a synthetic (untrusted) click must not approve: expect a timeout denial
ctx.once("page", (p) => p.waitForSelector("#allow").then(() => p.evaluate(() => document.getElementById("allow").click())));
console.log("synthetic click:", await s.click(2).then(() => "ALLOWED (bad)", (e) => `denied (good): ${e.message}`));

// 2. a real input-event click (what a human produces) approves
console.log(await s.snapshot());
ctx.once("page", (p) => p.click("#allow"));
console.log("trusted click:", await s.click(2).then((r) => `allowed (good): ${r}`, (e) => `DENIED (bad): ${e.message}`));
await s.close();
