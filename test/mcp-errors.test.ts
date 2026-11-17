import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { loadPolicy } from "../src/policy.js";

it("reports a failed launch as one short line, and the next call tries again", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-mcperr-"));
  const opts = {
    policy: loadPolicy(),
    profileDir: join(dir, "profile"),
    logFile: join(dir, "actions.jsonl"),
    channel: "no-such-browser",
    headless: true,
  };
  const { server, close } = createServer(opts);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const bad: any = await client.callTool({ name: "snapshot", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text.split("\n")).toHaveLength(1);
    expect(bad.content[0].text.length).toBeLessThanOrEqual(400);

    // a cached rejected launch would fail forever; fixing the cause must be enough
    opts.channel = process.env.LOCAL_BROWSER_CHANNEL ?? "chrome";
    const good: any = await client.callTool({ name: "open", arguments: { url: "about:blank" } });
    expect(good.isError).not.toBe(true);
  } finally {
    await client.close();
    await close();
  }
});
