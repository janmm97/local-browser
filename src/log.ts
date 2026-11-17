import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogEntry = {
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
  detail?: string;
  url?: string;
};

/** Appends one JSON line per action, so a run can be audited or replayed. */
export function createLog(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return (entry: LogEntry, secret = false) => {
    const args = secret && "text" in entry.args ? { ...entry.args, text: "[redacted]" } : entry.args;
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry, args }) + "\n");
  };
}
