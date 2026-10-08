export interface Spinner {
  verb: string;
  elapsedSec: number;
  detail: string | null;
}

const SCAN_LINES = 30;
// A real spinner line is short. A longer line is prose or output, and the cap also bounds the work per line.
const MAX_LINE_CHARS = 300;
const ALNUM = /^[\p{L}\p{N}]$/u;
// Markdown line starts that are prose or output, never the glyph Claude Code puts before its status verb.
const MARKDOWN_PREFIXES = new Set(["-", "+", ">", "#", "|", '"']);
const UPPER = /^\p{Lu}$/u;
const LETTER = /^\p{L}$/u;
const TIME_PART = /^(\d{1,6})([hms])$/;
const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };
const UNIT_ORDER = "hms";

/** `1m 44s`, `12s`, `1h 2m 3s` as seconds; null for anything else. Units must be in descending order. */
function elapsedSeconds(part: string): number | null {
  const tokens = part.split(" ");
  let total = 0;
  let lastUnit = -1;
  for (const token of tokens) {
    const m = TIME_PART.exec(token);
    if (!m) return null;
    const unit = UNIT_ORDER.indexOf(m[2]!);
    if (unit <= lastUnit) return null;
    lastUnit = unit;
    total += Number(m[1]) * UNIT_SECONDS[m[2]!]!;
  }
  return total;
}

/** One line such as `* Considering… (1m 44s · ↓ 9.0k tokens)`, or null. Walks the characters once, no backtracking. */
function parseLine(line: string): Spinner | null {
  if (line.length > MAX_LINE_CHARS) return null;
  const glyph = String.fromCodePoint(line.codePointAt(0)!);
  if (ALNUM.test(glyph) || /^\s$/u.test(glyph) || MARKDOWN_PREFIXES.has(glyph)) return null;
  let i = glyph.length;
  if (line[i] !== " ") return null;
  i++;

  const verbStart = i;
  const first = String.fromCodePoint(line.codePointAt(i) ?? 0x20);
  if (!UPPER.test(first)) return null;
  i += first.length;
  while (i < line.length) {
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (!(LETTER.test(ch) || ch === "'" || ch === "’" || ch === "-")) break;
    i += ch.length;
  }
  const verb = line.slice(verbStart, i);

  if (line[i] === "…") i += 1;
  else if (line.startsWith("...", i)) i += 3;
  else return null;
  if (!line.startsWith(" (", i)) return null;
  i += 2;
  if (!line.endsWith(")")) return null;
  const inner = line.slice(i, -1);

  let elapsedSec: number | null = null;
  const rest: string[] = [];
  for (const raw of inner.split(" · ")) {
    const part = raw.trim();
    if (!part) continue;
    if (elapsedSec === null) {
      const secs = elapsedSeconds(part);
      if (secs !== null) {
        elapsedSec = secs;
        continue;
      }
    }
    const lower = part.toLowerCase();
    if (lower.includes("esc to interrupt") || lower.includes("ctrl+")) continue;
    rest.push(part);
  }
  if (elapsedSec === null) return null;
  return { verb, elapsedSec, detail: rest.length ? rest.join(" · ") : null };
}

/**
 * The status line Claude Code prints while it works, taken from the screen text (which is untrusted).
 * Looks at the last 30 non-empty lines; the last match wins.
 */
export function parseSpinnerLine(screen: string): Spinner | null {
  const lines = screen.split("\n");
  let seen = 0;
  for (let n = lines.length - 1; n >= 0 && seen < SCAN_LINES; n--) {
    const line = lines[n]!.trim();
    if (!line) continue;
    seen++;
    const hit = parseLine(line);
    if (hit) return hit;
  }
  return null;
}
