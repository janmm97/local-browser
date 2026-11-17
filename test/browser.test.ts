import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Denied, Session } from "../src/browser.js";
import { loadPolicy, type Policy } from "../src/policy.js";

const PAGES: Record<string, string> = {
  "/": `<title>Home</title><h1>Welcome</h1><p>Hello   world</p>
    <a href="/next">Next page</a>
    <div style="display:none"><button>Hidden</button></div>
    <form action="/next"><label for="q">Search</label><input id="q" name="q" value="cats">
      <input type="password" value="hunter2" aria-label="Password"><button>Go</button></form>`,
  "/next": `<title>Next</title><p>Second page</p>`,
  "/badge": `<title>Shop</title><iframe src="/recaptcha/api2/anchor?size=invisible" width="256" height="60"></iframe><p>Hello</p><div class="g-recaptcha" style="display:none"></div>`,
  "/article": `<title>Blog</title><p>${"Why CAPTCHAs fail. ".repeat(100)}Some say press and hold to prove you are not a robot.</p>`,
  "/check": `<title>Access denied</title><div id="px-captcha" style="height:80px"></div><p>Press &amp; Hold to confirm you are a human</p>`,
};

let server: Server;
let base: string;
const dir = mkdtempSync(join(tmpdir(), "lb-browser-"));

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/redirect") return res.writeHead(302, { location: `http://localhost:${port()}/next` }).end();
    res.writeHead(PAGES[path] ? 200 : 404, { "content-type": "text/html" }).end(PAGES[path] ?? "nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${port()}`;
});
afterAll(() => server.close());
const port = () => (server.address() as { port: number }).port;

async function withSession(policy: Partial<Policy>, fn: (s: Session, log: () => any[]) => Promise<void>) {
  const name = Math.random().toString(36).slice(2);
  const logFile = join(dir, `${name}.jsonl`);
  const s = await Session.launch({
    policy: { ...loadPolicy(), ...policy },
    profileDir: join(dir, name),
    logFile,
    channel: process.env.LOCAL_BROWSER_CHANNEL ?? "chrome",
    headless: true,
  });
  const log = () => readFileSync(logFile, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
  try {
    await fn(s, log);
  } finally {
    await s.close();
  }
}

describe("Session", { timeout: 60_000 }, () => {
  it("snapshots visible elements with refs and never shows password values", () =>
    withSession({}, async (s) => {
      await s.open(base);
      const snap = await s.snapshot();
      expect(snap).toContain("# Home");
      expect(snap).toContain("# Welcome");
      expect(snap).toContain("Hello world");
      expect(snap).toContain('[1] link "Next page"');
      expect(snap).toContain('[2] text "Search" = "cats"');
      expect(snap).toContain('[3] password "Password" (password)');
      expect(snap).toContain('[4] button "Go"');
      expect(snap).not.toContain("Hidden");
      expect(snap).not.toContain("hunter2");
      expect(snap).not.toContain("bot check");
    }));

  it("flags bot checks so the agent hands them to the human", () =>
    withSession({}, async (s, log) => {
      for (const page of ["badge", "article"]) {
        await s.open(`${base}/${page}`); // an invisible reCAPTCHA badge and a long article about CAPTCHAs are not bot checks
        expect(await s.snapshot()).not.toContain("bot check");
      }
      await s.open(`${base}/check`);
      expect((await s.snapshot()).split("\n")[2]).toMatch(/bot check or CAPTCHA.*call ask_human/);
      await expect(s.handoff("Do the press-and-hold")).rejects.toThrow(/visible browser window/);
      expect(log().at(-1)).toMatchObject({ tool: "ask_human", outcome: "denied" });
    }));

  it("clicks and types by ref", () =>
    withSession({ confirm: [] }, async (s, log) => {
      await s.open(base);
      await s.snapshot();
      await s.type(2, "dogs", true);
      expect(await s.snapshot()).toContain("Second page");
      await s.back();
      await s.snapshot();
      expect(await s.click(1)).toContain("Next");
      await expect(s.click(99)).rejects.toThrow(/take a new snapshot/);
      expect(log().find((e) => e.tool === "type").args.text).toBe("[redacted]");
    }));

  it("denies risky steps in headless mode and logs them", () =>
    withSession({}, async (s, log) => {
      await s.open(base);
      await s.snapshot();
      await expect(s.type(2, "dogs", true)).rejects.toThrow(Denied);
      await expect(s.type(3, "secret")).rejects.toThrow(/needs a human yes/);
      await expect(s.click(4)).rejects.toThrow(Denied);
      expect(log().filter((e) => e.outcome === "denied")).toHaveLength(3);
    }));

  it("enforces domain policy, including after redirects", () =>
    withSession({ blockedDomains: ["localhost"] }, async (s) => {
      await expect(s.open(`http://localhost:${port()}/`)).rejects.toThrow(/blocked/);
      await expect(s.open("file:///etc/hosts")).rejects.toThrow(/not allowed/);
      await expect(s.open(`${base}/redirect`)).rejects.toThrow(Denied);
      expect(await s.snapshot()).toContain("url: about:blank");
    }));
});
