/**
 * Runs inside the page (passed to page.evaluate, so it must stay self-contained).
 * Numbers every visible interactive element with a data-lb-ref attribute and returns
 * a compact text outline: interactive elements as `[ref] role "name"`, plus headings and text blocks.
 */
export function pageSnapshot(max: number): string {
  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],' +
    "[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox]";
  const TEXT = "h1,h2,h3,h4,h5,h6,p,li,td,th,label,blockquote,pre,figcaption,dt,dd";
  const clean = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none";
  };

  const nameOf = (e: HTMLElement) => {
    const input = e as HTMLInputElement;
    const n =
      e.getAttribute("aria-label") ||
      input.labels?.[0]?.innerText ||
      e.getAttribute("placeholder") ||
      e.getAttribute("name") ||
      e.getAttribute("title") ||
      e.getAttribute("alt") ||
      e.innerText ||
      // button-like inputs show their value as the label; never use the value of text or password fields
      (["submit", "button", "reset"].includes(input.type) ? input.value : "");
    return clean(n, 80);
  };

  document.querySelectorAll("[data-lb-ref]").forEach((e) => e.removeAttribute("data-lb-ref"));
  const lines = [`# ${clean(document.title, 120)}`, `url: ${location.href}`];
  let ref = 0;

  for (const el of document.querySelectorAll<HTMLElement>(`${INTERACTIVE},${TEXT}`)) {
    if (!visible(el)) continue;
    if (el.matches(INTERACTIVE)) {
      el.setAttribute("data-lb-ref", String(++ref));
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? input.type || "text" : tag);
      let line = `[${ref}] ${role} "${nameOf(el)}"`;
      if (input.type === "password") line += " (password)";
      else if (["input", "textarea", "select"].includes(tag) && !["submit", "button", "reset", "checkbox", "radio"].includes(input.type) && input.value)
        line += ` = "${clean(input.value, 80)}"`;
      if (input.checked) line += " [checked]";
      if (input.disabled) line += " [disabled]";
      lines.push(line);
    } else if (!el.querySelector(TEXT)) {
      // innermost text blocks only, so nested lists and tables aren't repeated
      const text = clean(el.innerText, 300);
      if (!text) continue;
      const level = /^H([1-6])$/.exec(el.tagName)?.[1];
      lines.push(level ? `${"#".repeat(+level)} ${text}` : text);
    }
  }

  const out = lines.join("\n");
  return out.length > max ? `${out.slice(0, max)}\n… (snapshot cut at ${max} chars; scroll or raise maxSnapshotChars)` : out;
}
