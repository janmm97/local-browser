import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { loadPolicy } from "../src/policy.js";

let http: Server;
let base: string;
const dir = mkdtempSync(join(tmpdir(), "lb-mcp-"));
const { server, close } = createServer({
  policy: { ...loadPolicy(), blockedDomains: ["localhost"] },
  profileDir: join(dir, "profile"),
  logFile: join(dir, "actions.jsonl"),
  channel: process.env.LOCAL_BROWSER_CHANNEL ?? "chrome",
  headless: true,
});
const client = new Client({ name: "test", version: "0" });

beforeAll(async () => {
  http = createHttp((_, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(`<title>T</title><form><input name="q"><button>Go</button></form>`),
  );
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
  await close();
  http.close();
});

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

it("lists the tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["ask_human", "back", "click", "open", "screenshot", "scroll", "snapshot", "type"]);
});

it("opens, snapshots, screenshots and reports denials as tool errors", { timeout: 60_000 }, async () => {
  expect((await call("open", { url: base })).content[0].text).toMatch(/^ok: T/);
  expect((await call("snapshot")).content[0].text).toContain('[1] text "q"');
  const shot = await call("screenshot");
  expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

  const denied = await call("click", { ref: 2 }); // submit button, headless
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toMatch(/needs a human yes/);

  expect((await call("open", { url: "http://localhost/" })).content[0].text).toMatch(/blocked by policy/);
  expect((await call("click", { ref: "x" })).isError).toBe(true); // schema validation
});
