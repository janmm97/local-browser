import { readFileSync } from "node:fs";
import { z } from "zod";

/** Risky steps that can be made to wait for a human "yes". */
export const CONFIRMABLE = ["submit", "password"] as const;

/**
 * One entry of allowedDomains/blockedDomains, normalised the way URL hosts are (lower case, punycode, no trailing dot).
 * Anything that isn't a bare domain ("https://evil.com", "evil.com/x", "evil.com:8080") is rejected, because it
 * would never match a host and a blocked domain that silently never blocks is worse than an error.
 */
const domain = z.string().transform((s, ctx) => {
  const bare = s.trim().replace(/^\*?\./, "");
  try {
    const u = new URL(`http://${bare}`);
    if (!bare || u.host !== u.hostname || u.username || u.pathname !== "/" || u.search || u.hash) throw new Error();
    return u.hostname.replace(/\.$/, "");
  } catch {
    ctx.issues.push({ code: "custom", message: `not a bare domain like "example.com": ${JSON.stringify(s)}`, input: s });
    return z.NEVER;
  }
});

const PolicySchema = z.strictObject({
  /** If non-empty, only these domains (and their subdomains) may be visited. */
  allowedDomains: z.array(domain).default([]),
  /** Never visited, even if allowed. */
  blockedDomains: z.array(domain).default([]),
  /** Actions that need a human "yes" in the browser before they run. */
  confirm: z.array(z.enum(CONFIRMABLE)).default([...CONFIRMABLE]),
  /** Snapshots longer than this are cut. */
  maxSnapshotChars: z.number().int().positive().default(12000),
});

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(path?: string): Policy {
  const raw = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  return PolicySchema.parse(raw);
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const matches = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^\*?\./, "");
  return host === d || host.endsWith("." + d);
};

/** Returns null when the URL may be visited, or the reason it may not. */
export function checkUrl(policy: Policy, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `invalid URL: ${url}`;
  }
  if (u.protocol === "about:" && u.pathname === "blank") return null;
  // file:, chrome:, javascript:, data: … would let a page or agent reach local files or browser internals.
  if (!ALLOWED_SCHEMES.has(u.protocol)) return `scheme ${u.protocol} is not allowed`;
  const host = u.hostname.toLowerCase().replace(/\.$/, ""); // "evil.com." must match "evil.com"
  if (policy.blockedDomains.some((d) => matches(host, d))) return `${host} is blocked by policy`;
  if (policy.allowedDomains.length && !policy.allowedDomains.some((d) => matches(host, d)))
    return `${host} is not in allowedDomains`;
  return null;
}
