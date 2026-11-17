import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "../src/browser.js";
import { loadPolicy, type Policy } from "../src/policy.js";

// Submit paths the click detection can't see by itself (security review of PR #2).
const HOME = `<title>S</title>
<form id="f" method="post" action="/post"><input name="q"><input type="hidden" name="action" value="/fake"></form>
<button form="f">Outside</button>
<div role="button" onclick="document.getElementById('f').submit()">Scripted</div>
<form method="post" action="/post"><button>Inside</button></form>`;

let server: Server;
let base: string;
let posts = 0;
const dir = mkdtempSync(join(tmpdir(), "lb-submit-"));

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.writeHead(200, { "content-type": "text/html" }).end(req.method === "POST" ? "<title>Posted</title>ok" : HOME);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

async function withSession(policy: Partial<Policy>, fn: (s: Session) => Promise<void>) {
  posts = 0;
  const name = Math.random().toString(36).slice(2);
  const s = await Session.launch({
    policy: { ...loadPolicy(), ...policy },
    profileDir: join(dir, name),
    logFile: join(dir, `${name}.jsonl`),
    channel: process.env.LOCAL_BROWSER_CHANNEL ?? "chrome",
    headless: true,
  });
  try {
    await s.open(base);
    await s.snapshot(); // [1] input, [2] button form=f, [3] scripted div, [4] button inside form
    await fn(s);
  } finally {
    await s.close();
  }
}

// stands in for the human clicking Allow (the real prompt is tested in approval.test.ts)
const approve = (s: Session, during: () => Promise<unknown> = async () => {}) =>
  ((s as any).confirm = async () => void (await during()));

describe("submit approval", { timeout: 60_000 }, () => {
  it("treats <button form=…> as a submit", () =>
    withSession({}, async (s) => {
      await expect(s.click(2)).rejects.toThrow(/needs a human yes/);
      expect(posts).toBe(0);
    }));

  it("blocks a submit that page JavaScript triggers without approval", () =>
    withSession({}, async (s) => {
      await expect(s.click(3)).rejects.toThrow(/had not approved/);
      expect(posts).toBe(0);
      expect(await s.snapshot()).toContain("# S"); // still on the page, not an error page
    }));

  it("lets an approved submit through, and only that one", () =>
    withSession({}, async (s) => {
      approve(s);
      await s.click(2);
      expect(posts).toBe(1);
      await s.open(base);
      await s.snapshot();
      await expect(s.click(3)).rejects.toThrow(/had not approved/); // approval doesn't linger
      expect(posts).toBe(1);
    }));

  it("shows the human the button label and form target as written", () =>
    withSession({}, async (s) => {
      let shown = "";
      (s as any).confirm = async (_kind: string, detail: string) => void (shown = detail);
      await s.click(2);
      expect(shown).toContain('"Outside"');
      expect(shown).toContain(`sends the form to ${base}/post`);
    }));

  it("refuses to click a button the page swapped while the prompt was open", () =>
    withSession({}, async (s) => {
      approve(s, () => (s as any).page.evaluate(() => (document.querySelector('[data-lb-ref="4"]')!.textContent = "Delete everything")));
      await expect(s.click(4)).rejects.toThrow(/changed the button/);
      expect(posts).toBe(0);
    }));

  it("does not gate anything when the policy doesn't ask for submit approval", () =>
    withSession({ confirm: [] }, async (s) => {
      await s.click(3);
      expect(posts).toBe(1);
    }));
});

