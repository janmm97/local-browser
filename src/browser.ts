import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createLog } from "./log.js";
import { checkUrl, type Policy } from "./policy.js";
import { pageSnapshot } from "./snapshot.js";

export type SessionOptions = {
  policy: Policy;
  /** Isolated profile folder: never point this at your everyday browser profile. */
  profileDir: string;
  logFile: string;
  /** "chrome" or "msedge": the browser already installed on this machine. */
  channel?: string;
  headless?: boolean;
  /** How long a human has to answer an approval prompt. */
  approvalTimeoutMs?: number;
};

const APPROVAL_HTML = (action: string, detail: string) => `<!doctype html>
<title>local-browser: approve?</title>
<body style="font:16px system-ui;max-width:640px;margin:48px auto">
<h1>An AI agent wants to: ${action}</h1>
<pre id="d" style="white-space:pre-wrap;background:#f3f3f3;padding:12px"></pre>
<button id="allow" style="font-size:18px">Allow</button>
<button id="deny" style="font-size:18px">Deny</button>
<script>
document.getElementById("d").textContent = ${JSON.stringify(detail)};
// only real human clicks count (synthetic events are untrusted)
for (const id of ["allow", "deny"])
  document.getElementById(id).addEventListener("click", (e) => { if (e.isTrusted) window.__lbDecision = id; });
</script>`;

export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private approving = false;
  private log: ReturnType<typeof createLog>;

  private constructor(
    private context: BrowserContext,
    private page: Page,
    private opts: SessionOptions,
  ) {
    this.log = createLog(opts.logFile);
    // follow tabs the page opens (but never the approval tab)
    context.on("page", (p) => {
      if (!this.approving) this.page = p;
    });
  }

  static async launch(opts: SessionOptions) {
    const context = await chromium.launchPersistentContext(opts.profileDir, {
      channel: opts.channel ?? "chrome",
      headless: opts.headless ?? false,
      acceptDownloads: false, // v0.1: no downloads at all
      viewport: { width: 1280, height: 800 },
    });
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && checkUrl(opts.policy, req.url())) return route.abort("blockedbyclient");
      return route.continue();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return new Session(context, page, opts);
  }

  /** Serialises actions, enforces the URL policy afterwards (redirects skip routing) and logs every step. */
  private run<T>(tool: string, args: Record<string, unknown>, fn: () => Promise<T>, secret = false): Promise<T> {
    const next = this.queue.then(async () => {
      try {
        const result = await fn();
        const blocked = checkUrl(this.opts.policy, this.page.url());
        if (blocked) {
          await this.page.goto("about:blank");
          throw new Denied(`navigation stopped: ${blocked}`);
        }
        this.log({ tool, args, outcome: "ok", url: this.page.url() }, secret);
        return result;
      } catch (e) {
        const outcome = e instanceof Denied ? "denied" : "error";
        this.log({ tool, args, outcome, detail: String((e as Error).message), url: this.page.url() }, secret);
        throw e;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async confirm(kind: "submit" | "password", detail: string) {
    if (!this.opts.policy.confirm.includes(kind)) return;
    if (this.opts.headless) throw new Denied(`"${kind}" needs a human yes; run headed or remove it from policy.confirm`);
    // stays true until the prompt is closed: the "page" event can fire after newPage() resolves
    this.approving = true;
    const prompt = await this.context.newPage();
    try {
      await prompt.setContent(APPROVAL_HTML(kind === "submit" ? "submit a form" : "type into a password field", detail));
      await prompt.bringToFront();
      const handle = await prompt.waitForFunction(() => (window as any).__lbDecision, null, {
        timeout: this.opts.approvalTimeoutMs ?? 120_000,
        polling: 200,
      });
      if ((await handle.jsonValue()) !== "allow") throw new Denied(`human denied: ${kind}`);
    } catch (e) {
      throw e instanceof Denied ? e : new Denied(`no human answer for: ${kind}`);
    } finally {
      await prompt.close().catch(() => {});
      this.approving = false;
      await this.page.bringToFront().catch(() => {});
    }
  }

  private async el(ref: number) {
    const el = this.page.locator(`[data-lb-ref="${ref}"]`);
    if ((await el.count()) !== 1) throw new Error(`ref ${ref} not found: take a new snapshot`);
    return el;
  }

  private async summary() {
    return `ok: ${await this.page.title()} (${this.page.url()})`;
  }

  open(url: string) {
    return this.run("open", { url }, async () => {
      const blocked = checkUrl(this.opts.policy, url);
      if (blocked) throw new Denied(blocked);
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      return this.summary();
    });
  }

  snapshot() {
    return this.run("snapshot", {}, () => this.page.evaluate(pageSnapshot, this.opts.policy.maxSnapshotChars));
  }

  click(ref: number) {
    return this.run("click", { ref }, async () => {
      const el = await this.el(ref);
      const isSubmit = await el.evaluate((e) =>
        e.matches("button[type=submit],input[type=submit],input[type=image],form button:not([type])"),
      );
      if (isSubmit) await this.confirm("submit", `click [${ref}] "${(await el.innerText()).slice(0, 80)}" on ${this.page.url()}`);
      await el.click({ timeout: 10_000 });
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      return this.summary();
    });
  }

  // typed text is always redacted in the log: it is often personal
  type(ref: number, text: string, submit = false) {
    return this.run(
      "type",
      { ref, text, submit },
      async () => {
        const el = await this.el(ref);
        if (await el.evaluate((e) => (e as HTMLInputElement).type === "password"))
          await this.confirm("password", `type into password field [${ref}] on ${this.page.url()}`);
        if (submit) await this.confirm("submit", `type into [${ref}] and press Enter on ${this.page.url()}`);
        await el.fill(text, { timeout: 10_000 });
        if (submit) {
          await el.press("Enter");
          await this.page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        return this.summary();
      },
      true,
    );
  }

  scroll(direction: "up" | "down") {
    return this.run("scroll", { direction }, async () => {
      await this.page.mouse.wheel(0, direction === "down" ? 600 : -600);
      return this.summary();
    });
  }

  back() {
    return this.run("back", {}, async () => {
      await this.page.goBack({ waitUntil: "domcontentloaded" });
      return this.summary();
    });
  }

  screenshot() {
    return this.run("screenshot", {}, async () =>
      (await this.page.screenshot({ type: "jpeg", quality: 60 })).toString("base64"),
    );
  }

  close() {
    return this.context.close();
  }
}

/** A step the policy or the human refused (as opposed to a technical error). */
export class Denied extends Error {}
