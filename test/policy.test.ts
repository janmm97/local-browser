import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLog } from "../src/log.js";
import { checkUrl, loadPolicy } from "../src/policy.js";

const dir = mkdtempSync(join(tmpdir(), "lb-test-"));

describe("loadPolicy", () => {
  it("has safe defaults", () => {
    const p = loadPolicy();
    expect(p.confirm).toEqual(["submit", "password"]);
    expect(p.allowedDomains).toEqual([]);
  });

  it("rejects unknown keys and bad values", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ confirm: ["everything"] }));
    expect(() => loadPolicy(f)).toThrow();
    writeFileSync(f, JSON.stringify({ allowDomains: ["typo.com"] }));
    expect(() => loadPolicy(f)).toThrow();
  });
});

describe("checkUrl", () => {
  const p = loadPolicy();

  it("allows http(s) and about:blank by default", () => {
    expect(checkUrl(p, "https://example.com/a")).toBeNull();
    expect(checkUrl(p, "about:blank")).toBeNull();
  });

  it("blocks local and internal schemes", () => {
    for (const u of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,hi"])
      expect(checkUrl(p, u)).toMatch(/not allowed/);
    expect(checkUrl(p, "not a url")).toMatch(/invalid/);
  });

  it("applies blocked and allowed domains to subdomains only", () => {
    const q = { ...p, allowedDomains: ["example.com"], blockedDomains: ["admin.example.com"] };
    expect(checkUrl(q, "https://www.example.com")).toBeNull();
    expect(checkUrl(q, "https://admin.example.com")).toMatch(/blocked/);
    expect(checkUrl(q, "https://admin.example.com./x")).toMatch(/blocked/);
    expect(checkUrl(q, "https://evilexample.com")).toMatch(/not in allowedDomains/);
    expect(checkUrl(q, "https://example.com.evil.net")).toMatch(/not in allowedDomains/);
  });
});

describe("createLog", () => {
  it("writes JSONL and redacts secrets", () => {
    const f = join(dir, "sub", "actions.jsonl");
    const log = createLog(f);
    log({ tool: "open", args: { url: "https://example.com" }, outcome: "ok" });
    log({ tool: "type", args: { ref: 3, text: "hunter2" }, outcome: "ok" }, true);
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe("open");
    expect(lines[1].args.text).toBe("[redacted]");
    expect(readFileSync(f, "utf8")).not.toContain("hunter2");
  });
});
