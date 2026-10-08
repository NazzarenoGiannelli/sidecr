import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

const MAX_NAME_CHARS = 40;

/** Single line, no control characters, at most 40 characters. The text is shown in the window header. */
function tidy(raw: string): string {
  const flat = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "") // controls that are not whitespace
    .replace(/\s+/g, " ")
    .trim();
  return flat.slice(0, MAX_NAME_CHARS).trimEnd();
}

/** The label shown for this machine: `<dir>/machine-name` when it has text, else the hostname. Never throws. */
export function readMachineName(dir: string, hostname: () => string = osHostname): string {
  try {
    const name = tidy(readFileSync(join(dir, "machine-name"), "utf8"));
    if (name) return name;
  } catch {
    /* missing or unreadable: fall back to the hostname */
  }
  try {
    return tidy(String(hostname()));
  } catch {
    return "";
  }
}
