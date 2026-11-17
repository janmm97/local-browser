import { chromium, type BrowserContext, type Locator, type Page, type Route } from "playwright-core";
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

// No page-controlled text ever goes into this markup: the detail is set as textContent after load.
const APPROVAL_HTML = (action: string) => `<!doctype html>
<title>local-browser: approve?</title>
<body style="font:16px system-ui;max-width:640px;margin:48px auto">
<h1>An AI agent wants to: ${action}</h1>
<pre id="d" style="white-space:pre-wrap;background:#f3f3f3;padding:12px"></pre>
<button id="allow" style="font-size:18px">Allow</button>
<button id="deny" style="font-size:18px">Deny</button>
<script>
// only real human clicks count (synthetic events are untrusted)
for (const id of ["allow", "deny"])
  document.getElementById(id).addEventListener("click", (e) => { if (e.isTrusted) window.__lbDecide(id); });
</script>`;

/** Opens a local Allow/Deny tab and resolves true only on a real click on Allow. Timeout or closing the tab means no. */
export async function askHuman(context: BrowserContext, action: string, detail: string, timeoutMs: number) {
  const prompt = await context.newPage();
  let timer: NodeJS.Timeout | undefined;
  try {
    // the decision lives in Node, not in a page variable a script could set
    let decide!: (id: string) => void;
    const decision = new Promise<string>((resolve) => (decide = resolve));
    await prompt.exposeBinding("__lbDecide", (_src, id: string) => decide(id));
    prompt.once("close", () => decide("closed"));
    timer = setTimeout(() => decide("timeout"), timeoutMs);
    await prompt.setContent(APPROVAL_HTML(action));
    await prompt.locator("#d").evaluate((el, d) => { el.textContent = d; }, detail);
    await prompt.bringToFront();
    return (await decision) === "allow";
  } finally {
    clearTimeout(timer);
    await prompt.close().catch(() => {});
  }
}

export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private approving = false;
  // true only while a click/Enter the human approved is running (see guard)
  private submitApproved = false;
  private blockedSubmit = false;
  private log: ReturnType<typeof createLog>;
  /** Resolves when the browser context closes (the human closed the window, or close() ran). */
  readonly closed: Promise<void>;

  private constructor(
    private context: BrowserContext,
    private page: Page,
    private opts: SessionOptions,
  ) {
    this.log = createLog(opts.logFile);
    this.closed = new Promise((resolve) => context.once("close", () => resolve()));
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
      serviceWorkers: "block", // a service worker would answer requests before route() sees them
      viewport: { width: 1280, height: 800 },
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session = new Session(context, page, opts);
    await context.route("**/*", (route) => session.guard(route));
    return session;
  }

  /**
   * Every request passes here. Navigations to forbidden URLs are refused. Form POSTs are refused unless a click
   * or Enter the human approved caused them: that catches submits the click detection can't see
   * (page-JS form.submit(), a label that triggers a submit button, odd markup).
   */
  private guard(route: Route) {
    const req = route.request();
    if (req.isNavigationRequest()) {
      if (checkUrl(this.opts.policy, req.url())) return route.abort("blockedbyclient");
      const post = req.method() !== "GET" && req.method() !== "HEAD";
      if (post && this.opts.policy.confirm.includes("submit") && !this.submitApproved) {
        this.blockedSubmit = true;
        return route.abort("aborted"); // "aborted" keeps the current page instead of showing an error page
      }
    }
    return route.continue();
  }

  /** Serialises actions, enforces the URL policy afterwards (redirects skip routing) and logs every step. */
  private run<T>(tool: string, args: Record<string, unknown>, fn: () => Promise<T>, secret = false): Promise<T> {
    const next = this.queue.then(async () => {
      // a popup or the human may have closed the tab we were on
      if (this.page.isClosed()) this.page = this.context.pages().find((p) => !p.isClosed()) ?? (await this.context.newPage());
      this.blockedSubmit = false;
      try {
        const result = await fn();
        if (this.blockedSubmit) throw new Denied("a form submit the human had not approved was blocked");
        const blocked = checkUrl(this.opts.policy, this.page.url());
        if (blocked) {
          await this.page.goto("about:blank").catch(() => {});
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
    try {
      const ok = await askHuman(
        this.context,
        kind === "submit" ? "submit a form" : "type into a password field",
        detail,
        this.opts.approvalTimeoutMs ?? 120_000,
      );
      if (!ok) throw new Denied(`human denied or no answer: ${kind}. Do not retry unless the user asks.`);
    } finally {
      this.approving = false;
      await this.page.bringToFront().catch(() => {});
    }
  }

  /** Runs a step the human has approved (if `approved`), letting its form POST through guard(). */
  private async approved<T>(approved: boolean, fn: () => Promise<T>) {
    this.submitApproved = approved;
    try {
      return await fn();
    } finally {
      this.submitApproved = false;
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
      const before = await describe(el);
      if (before.submit) {
        await this.confirm("submit", `click [${ref}] ${JSON.stringify(before.label)}, sends the form to ${before.action}, on ${this.page.url()}`);
        // the page had up to two minutes to swap the button for another one
        if (JSON.stringify(await describe(el)) !== JSON.stringify(before))
          throw new Denied("the page changed the button while waiting for approval: take a new snapshot");
      }
      return this.approved(before.submit, async () => {
        await el.click({ timeout: 10_000 });
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
        return this.summary();
      });
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
        if (submit) {
          const { action } = await describe(el);
          await this.confirm("submit", `type into [${ref}] and press Enter, sends the form to ${action || "(no form)"}, on ${this.page.url()}`);
        }
        return this.approved(submit, async () => {
          await el.fill(text, { timeout: 10_000 });
          if (submit) {
            await el.press("Enter");
            await this.page.waitForLoadState("domcontentloaded").catch(() => {});
          }
          return this.summary();
        });
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

/**
 * What the approval prompt shows about an element. The form's target is read through the prototype getter,
 * because `form.action` can be clobbered by an input named "action".
 */
function describe(el: Locator) {
  return el.evaluate((e) => {
    const b = e as HTMLInputElement; // button and input share the properties used here
    const submit = (e instanceof HTMLButtonElement && b.type === "submit") || (e instanceof HTMLInputElement && (b.type === "submit" || b.type === "image"));
    // button.formAction falls back to the page URL when the attribute is missing, so only use it when it's set
    const formAction = !b.form
      ? ""
      : b.hasAttribute("formaction")
        ? b.formAction
        : (Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "action")!.get!.call(b.form) as string);
    return {
      submit: submit && !!b.form,
      label: (b.innerText || b.value || b.alt || "").replace(/\s+/g, " ").trim().slice(0, 80),
      action: formAction.slice(0, 200),
    };
  });
}

/** A step the policy or the human refused (as opposed to a technical error). */
export class Denied extends Error {}
