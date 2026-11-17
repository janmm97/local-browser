import { randomUUID } from "node:crypto";
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
  /** How long ask_human waits for the human to finish and click Done (default 10 minutes). */
  handoffTimeoutMs?: number;
};

// No page-controlled text ever goes into this markup: the detail is set as textContent after load.
const APPROVAL_HTML = (action: string, yes: string, no: string) => `<!doctype html>
<title>local-browser: approve?</title>
<body style="font:16px system-ui;max-width:640px;margin:48px auto">
<h1>${action}</h1>
<pre id="d" style="white-space:pre-wrap;background:#f3f3f3;padding:12px"></pre>
<button id="allow" style="font-size:18px" disabled>${yes}</button>
<button id="deny" style="font-size:18px" disabled>${no}</button>
<script>
// only real human clicks count (synthetic events are untrusted)
for (const id of ["allow", "deny"])
  document.getElementById(id).addEventListener("click", (e) => { if (e.isTrusted) window.__lbDecide(id); });
</script>`;

const GESTURE_WINDOW_MS = 3_000;
export const BUTTON_DELAY_MS = 1_000;

/**
 * Opens a local yes/no tab and resolves true only on a real click on the yes button. Timeout or closing the tab means no.
 * `title` and the labels are fixed strings from this file; page-controlled text only ever goes in `detail`.
 */
export async function askHuman(context: BrowserContext, title: string, detail: string, timeoutMs: number, yes = "Allow", no = "Deny") {
  const prompt = await context.newPage();
  let timer: NodeJS.Timeout | undefined;
  try {
    // the decision lives in Node, not in a page variable a script could set
    let decide!: (id: string) => void;
    const decision = new Promise<string>((resolve) => (decide = resolve));
    await prompt.exposeBinding("__lbDecide", (_src, id: string) => decide(id));
    prompt.once("close", () => decide("closed"));
    timer = setTimeout(() => decide("timeout"), timeoutMs);
    await prompt.setContent(APPROVAL_HTML(title, yes, no));
    await prompt.locator("#d").evaluate((el, d) => { el.textContent = d; }, detail);
    await prompt.bringToFront();
    // the buttons start disabled, so a click meant for the page can't land on Allow (like Chrome's permission prompts)
    await new Promise((r) => setTimeout(r, BUTTON_DELAY_MS));
    await prompt.evaluate(() => document.querySelectorAll("button").forEach((b) => (b.disabled = false))).catch(() => {});
    return (await decision) === "allow";
  } finally {
    clearTimeout(timer);
    await prompt.close().catch(() => {});
  }
}

export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private approving = false;
  // the form target the human approved, set only while that click/Enter runs; one POST to it may pass (see guard)
  private approvedTarget: string | null = null;
  private blockedSubmit = false;
  // when the human last clicked or pressed a key in any page (real input only), see launch()
  private lastGesture = 0;
  // true while the human has the browser (ask_human): a form submit passes only right after a real human click or key press, the domain policy still applies
  private humanDriving = false;
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
    // Real input only: the page reports isTrusted events through a binding it can't use without the token, which only
    // this init script's closure holds (it keeps its own reference to the binding before any page script runs).
    // Best effort, not a security boundary: Playwright's binding wrapper serialises the token with the page's global
    // JSON.stringify, so a hostile page that patches it can read the token after one real click and fake gestures.
    const token = randomUUID();
    await context.exposeBinding("__lbGesture", (_src, t: string) => {
      if (t === token) session.lastGesture = Date.now();
    });
    await context.addInitScript(
      `(() => { const send = window.__lbGesture, t = ${JSON.stringify(token)}; for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, (e) => { if (e.isTrusted) send(t); }, true); })();`,
    );
    await context.route("**/*", (route) => session.guard(route));
    return session;
  }

  /**
   * Every request passes here. Navigations to forbidden URLs are refused. Form POSTs are refused unless they go to
   * the target the human just approved, once: that catches submits the click detection can't see
   * (page-JS form.submit(), a label that triggers a submit button, odd markup) and a page swapping the target.
   */
  private async guard(route: Route) {
    const req = route.request();
    if (req.isNavigationRequest()) {
      if (checkUrl(this.opts.policy, req.url())) return route.abort("blockedbyclient");
      const post = req.method() !== "GET" && req.method() !== "HEAD";
      // during ask_human a POST passes only within a few seconds of a real human click or key press (isTrusted events,
      // reported by the init script in launch()), so an ordinary page doesn't POST on its own while the human takes their
      // time. A hostile page can still get past this (see launch()), as it can with fetch(), which was never gated.
      if (post && this.opts.policy.confirm.includes("submit") && !(this.humanDriving && (await this.recentGesture()))) {
        if (this.approvedTarget === null || noHash(req.url()) !== noHash(this.approvedTarget)) {
          this.blockedSubmit = true;
          return route.abort("aborted"); // "aborted" keeps the current page instead of showing an error page
        }
        this.approvedTarget = null; // one approval, one POST
      }
    }
    return route.continue();
  }

  /**
   * True if a real human click or key press reached a page in the last few seconds (see launch()). A short wait covers
   * the binding message arriving just after the request does. Fails closed.
   */
  private async recentGesture() {
    for (let i = 0; i < 8; i++) {
      if (Date.now() - this.lastGesture < GESTURE_WINDOW_MS) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
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
        `An AI agent wants to: ${kind === "submit" ? "submit a form" : "type into a password field"}`,
        detail,
        this.opts.approvalTimeoutMs ?? 120_000,
      );
      if (!ok) throw new Denied(`human denied or no answer: ${kind}. Do not retry unless the user asks.`);
    } finally {
      this.approving = false;
      await this.page.bringToFront().catch(() => {});
    }
  }

  /** Runs a step, letting one form POST to `target` (the URL the human approved) through guard(). */
  private async approved<T>(target: string | null, fn: () => Promise<T>) {
    this.approvedTarget = target || null;
    try {
      return await fn();
    } finally {
      this.approvedTarget = null;
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
        await this.confirm("submit", `click [${ref}] ${JSON.stringify(before.label)}, sends the form to ${before.action.slice(0, 200)}, on ${this.page.url()}`);
        // the page had up to two minutes to swap the button for another one
        if (JSON.stringify(await describe(el)) !== JSON.stringify(before))
          throw new Denied("the page changed the button while waiting for approval: take a new snapshot");
      }
      return this.approved(before.submit ? before.action : null, async () => {
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
        const action = submit ? (await describe(el)).action : "";
        if (submit)
          await this.confirm("submit", `type into [${ref}] and press Enter, sends the form to ${action.slice(0, 200) || "(no form)"}, on ${this.page.url()}`);
        return this.approved(action, async () => {
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

  /**
   * Hands the browser to the human for a step only a person should do (a CAPTCHA, a "press and hold" bot check,
   * a 2FA login). The agent never solves those itself: it waits until the human clicks Done, then carries on in the
   * same session. Returns a fresh snapshot.
   */
  handoff(reason: string) {
    return this.run("ask_human", { reason }, async () => {
      if (this.opts.headless) throw new Denied("ask_human needs a visible browser window: run without --headless");
      const where = `${await this.page.title()} (${this.page.url()})`.slice(0, 300);
      this.approving = true;
      this.humanDriving = true;
      this.lastGesture = 0;
      try {
        const done = await askHuman(
          this.context,
          "An AI agent needs you to do a step yourself",
          `${reason}\n\nOn: ${where}\n\n(Written by the AI agent. A page can steer it, so check it makes sense.)\nSwitch to that tab, do it there, then come back to this tab and click Done. Click Give up if this isn't what you expected.`,
          this.opts.handoffTimeoutMs ?? 600_000,
          "Done",
          "Give up",
        );
        if (!done) throw new Denied("the human gave up or didn't answer. Do not retry unless the user asks.");
      } finally {
        this.approving = false;
        this.humanDriving = false;
        await this.page.bringToFront().catch(() => {});
      }
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      return this.page.evaluate(pageSnapshot, this.opts.policy.maxSnapshotChars);
    });
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
      action: formAction, // full URL: guard() matches the POST against it
    };
  });
}

const noHash = (u: string) => u.split("#")[0];

/** A step the policy or the human refused (as opposed to a technical error). */
export class Denied extends Error {}
