import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Session, type SessionOptions } from "./browser.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function createServer(opts: SessionOptions) {
  const server = new McpServer({ name: "local-browser", version: "0.1.0" });
  // the browser opens on the first tool call, not when the agent starts
  let session: Promise<Session> | undefined;
  const browser = () => (session ??= Session.launch(opts));

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    fn: (s: Session, args: z.infer<z.ZodObject<S>>) => Promise<Content>,
  ) =>
    server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return { content: [await fn(await browser(), args)] };
      } catch (e) {
        return { content: [{ type: "text", text: `${(e as Error).name}: ${(e as Error).message}` }], isError: true };
      }
    }) as never);

  const text = async (p: Promise<string>): Promise<Content> => ({ type: "text", text: await p });
  const ref = z.number().int().positive().describe("Element number from the latest snapshot");

  tool("open", "Open a URL in the browser. Returns the page title.", { url: z.string() }, (s, a) => text(s.open(a.url)));
  tool("snapshot", "Compact text view of the page: [ref] role \"name\" for things you can click or type in, plus headings and text.", {}, (s) => text(s.snapshot()));
  tool("click", "Click an element by ref. Form submits may wait for a human to approve.", { ref }, (s, a) => text(s.click(a.ref)));
  tool(
    "type",
    "Fill an input by ref. submit=true presses Enter (may wait for human approval).",
    { ref, text: z.string(), submit: z.boolean().optional() },
    (s, a) => text(s.type(a.ref, a.text, a.submit)),
  );
  tool("scroll", "Scroll the page.", { direction: z.enum(["up", "down"]) }, (s, a) => text(s.scroll(a.direction)));
  tool("back", "Go back one page.", {}, (s) => text(s.back()));
  tool("screenshot", "JPEG screenshot of the visible page. Costs far more tokens than snapshot: use only when layout matters.", {}, async (s) => ({
    type: "image",
    data: await s.screenshot(),
    mimeType: "image/jpeg",
  }));

  return { server, close: async () => session && (await session).close() };
}

export async function serveStdio(opts: SessionOptions) {
  const { server, close } = createServer(opts);
  const stop = () => void close().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
  await server.connect(new StdioServerTransport());
}
