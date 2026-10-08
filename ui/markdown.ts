import { tokenize, tokenizeCode, tokenizeFenceBody } from "../src/tokenize";

// A small, forgiving markdown parser for assistant replies. It is pure (no DOM, no Node) and total:
// any string gives a result, quickly, and nothing in the text is ever interpreted as HTML.
// Output is plain data; ui/markdown-dom.ts turns it into elements.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang: string; v: string; closed: boolean }
  | { t: "quote"; c: Block[] }
  | { t: "ul" | "ol"; start?: number; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right" | null)[] };

/** Blocks nested deeper than this (quotes in quotes, lists in lists) are shown as plain paragraphs. */
const MAX_BLOCK_DEPTH = 24;
/** Links nested in link text deeper than this are shown as plain text. */
const MAX_INLINE_DEPTH = 6;
/** The scan for a link's closing bracket gives up after this many characters, which keeps unclosed `[` linear. */
const MAX_LINK_TEXT = 1000;
const MAX_HREF = 2000;
/** Emphasis and links nest at most this deep; past it the remaining delimiters stay literal text. */
const MAX_NESTING = 32;
/** A table keeps at most this many columns and rows; the rest is dropped. */
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_ROWS = 500;

// ---------------------------------------------------------------------------------------------------------------
// Links

/**
 * The URL when it is a plain http(s) URL, otherwise null. Used before a link target reaches the DOM:
 * `javascript:`, `data:`, scheme-relative and relative URLs, and anything with whitespace or control characters in it are refused.
 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.length === 0 || h.length > MAX_HREF) return null;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(h)) return null;
  if (!/^https?:\/\/[^/?#]/i.test(h)) return null;
  try {
    const u = new URL(h);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // The normalised form is what is shown and opened (a homograph host is punycode, a backslash is a slash),
    // so it is the one that must stay under the cap too.
    return u.href.length > MAX_HREF ? null : u.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Inline

interface Delim {
  kind: "delim";
  ch: "*" | "_" | "~";
  count: number;
  orig: number;
  open: boolean;
  close: boolean;
}
type Item = Inline | Delim;

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
// Character classes of a relative path, as char codes so the scan below never needs a regex over untrusted text.
const isFirstSegmentChar = (c: number) => isWordCode(c) || c === 46 /* . */ || c === 64; /* @ */
const isSegmentChar = (c: number) => isFirstSegmentChar(c) || c === 43 /* + */ || c === 45; /* - */
const isWordCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
// A path does not start right after one of these: `a-b/c` and `x:y/z` are something else, and `/a/b` is an absolute path.
const blocksPathStart = (c: number) => isWordCode(c) || c === 47 /* / */ || c === 46 /* . */ || c === 58 /* : */ || c === 92 /* \ */ || c === 45; /* - */

/**
 * Relative paths with at least two segments (`src/__tests__/a.test.ts`; tokenize only knows absolute ones), as [start, end) pairs.
 * One left-to-right pass that never looks at a position twice, so it is linear however long the runs are
 * (a lookbehind regex with a greedy class backtracked quadratically on runs of `@`).
 */
function relativePathSpans(s: string): [number, number][] {
  const out: [number, number][] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (!isFirstSegmentChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    // i starts a maximal run of first-segment characters: scan it once.
    let runEnd = i + 1;
    while (runEnd < n && isFirstSegmentChar(s.charCodeAt(runEnd))) runEnd++;
    let end = runEnd;
    if (i === 0 || !blocksPathStart(s.charCodeAt(i - 1))) {
      let segments = 0;
      while (end + 1 < n && s.charCodeAt(end) === 47 && isSegmentChar(s.charCodeAt(end + 1))) {
        end += 2;
        while (end < n && isSegmentChar(s.charCodeAt(end))) end++;
        segments++;
      }
      if (segments > 0) out.push([i, end]);
      else end = runEnd;
    }
    i = end;
  }
  return out;
}

/** Characters that may close emphasis are not part of a URL or path for the purpose of protecting it: `**https://x.dev**` is bold. */
function trimClosers(s: string, start: number, end: number): number {
  for (;;) {
    const c = s[end - 1];
    if (end <= start) return end;
    if (c === "*" || c === "_") end--;
    else if (c === "~") {
      // only a run of exactly two is a strike-through delimiter; a single trailing ~ (a backup file) stays
      let k = end;
      while (k > start && s[k - 1] === "~") k--;
      if (end - k !== 2) return end;
      end = k;
    } else return end;
  }
}

/**
 * The spans of a text that are a URL or a path (as src/tokenize.ts sees them, plus relative paths), as [start, end) pairs in order.
 * Their characters are literal: `__tests__` in a path is not bold, and `\.` in `C:\Users\x\.claude` is not an escaped dot.
 * A closing `*`, `_` or `~~` at the very end is left out of the span, so emphasis around a URL or path still works.
 */
function protectedSpans(s: string): [number, number][] {
  const found: [number, number][] = [];
  let at = 0;
  for (const t of tokenize(s)) {
    if (t.type !== "text") {
      const end = trimClosers(s, at, at + t.value.length);
      if (end > at) found.push([at, end]);
    }
    at += t.value.length;
  }
  for (const [rawStart, rawEnd] of relativePathSpans(s)) {
    // Underscores at the very ends stay free so `_src/a.ts_` is still italic.
    let start = rawStart;
    while (start < rawEnd && s[start] === "_") start++;
    const end = trimClosers(s, start, rawEnd);
    if (end > start) found.push([start, end]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const span of found) {
    const last = out.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

const isWs = (c: string) => /\s/.test(c);
const isPunct = (c: string) => /[\p{P}\p{S}]/u.test(c);
const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);

const isDelim = (it: Item): it is Delim => "kind" in it;

/** Where the `]` that closes the `[` at `open` is, within MAX_LINK_TEXT characters; -1 if there is none. */
function findClosingBracket(s: string, open: number): number {
  let depth = 0;
  const limit = Math.min(s.length, open + MAX_LINK_TEXT + 1);
  for (let i = open; i < limit; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** `(url)` or `(url "title")` starting at the `(` at `at`. Returns the URL and the index after the `)`. */
function parseLinkTarget(s: string, at: number): { href: string; end: number } | null {
  let i = at + 1;
  while (s[i] === " " || s[i] === "\t") i++;
  const start = i;
  let depth = 0;
  while (i < s.length && i - start <= MAX_HREF) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  const href = s.slice(start, i);
  while (s[i] === " " || s[i] === "\t") i++;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    const close = s.indexOf(q, i + 1);
    if (close < 0 || close - i > 500) return null;
    i = close + 1;
    while (s[i] === " " || s[i] === "\t") i++;
  }
  if (s[i] !== ")") return null;
  return { href, end: i + 1 };
}

function toInlines(items: Item[]): Inline[] {
  const out: Inline[] = [];
  const push = (n: Inline) => {
    const last = out.at(-1);
    if (n.t === "text") {
      if (n.v === "") return;
      if (last?.t === "text") {
        last.v += n.v;
        return;
      }
      out.push({ t: "text", v: n.v });
    } else out.push(n);
  };
  for (const it of items) {
    if (isDelim(it)) push({ t: "text", v: it.ch.repeat(it.count) });
    else push(it);
  }
  return out;
}

const depthMemo = new WeakMap<object, number>();

/** Nesting depth of one node: 0 for text, code and br. Memoised, so a tree is measured once however often it is asked. */
function nodeDepth(n: Inline): number {
  if (!("c" in n)) return 0;
  let d = depthMemo.get(n);
  if (d === undefined) {
    d = 1 + n.c.reduce((m, child) => Math.max(m, nodeDepth(child)), 0);
    depthMemo.set(n, d);
  }
  return d;
}

function resolveEmphasis(items: Item[]): Inline[] {
  // One stack of still-open delimiters (indices into items) per character: a closer only ever looks at its own kind.
  const stacks: Record<string, number[]> = { "*": [], _: [], "~": [] };
  let j = 0;
  while (j < items.length) {
    const it = items[j];
    if (!isDelim(it)) {
      j++;
      continue;
    }
    const stack = stacks[it.ch];
    if (it.close && it.count > 0) {
      let found = -1;
      for (let si = stack.length - 1; si >= 0; si--) {
        const o = items[stack[si]] as Delim;
        if (o.count <= 0) continue;
        // CommonMark's "rule of 3" keeps `*a**b*` style runs from pairing wrongly.
        if (it.ch !== "~" && (o.close || it.open) && (o.orig + it.orig) % 3 === 0 && !(o.orig % 3 === 0 && it.orig % 3 === 0)) continue;
        found = si;
        break;
      }
      if (found >= 0) {
        const k = stack[found];
        const o = items[k] as Delim;
        const use = it.ch === "~" ? 2 : o.count >= 2 && it.count >= 2 ? 2 : 1;
        const inner = toInlines(items.slice(k + 1, j));
        // Past MAX_NESTING levels the rest is left as it is: every delimiter still unmatched becomes literal text.
        if (1 + inner.reduce((m, child) => Math.max(m, nodeDepth(child)), 0) > MAX_NESTING) return toInlines(items);
        const node: Inline = it.ch === "~" ? { t: "del", c: inner } : use === 2 ? { t: "strong", c: inner } : { t: "em", c: inner };
        o.count -= use;
        it.count -= use;
        items.splice(k + 1, j - k - 1, node);
        j = k + 2; // the closer, now right after the new node
        // Delimiters that sat between opener and closer are consumed (now inside the node).
        stack.length = found + 1;
        if (o.count === 0) stack.pop();
        for (const other of Object.values(stacks)) {
          while (other.length && other[other.length - 1] > k) other.pop();
        }
        if (it.count === 0) j++;
        continue;
      }
      if (!it.open) {
        j++;
        continue; // an unmatched closer is literal text
      }
    }
    if (it.open && it.count > 0) stack.push(j);
    j++;
  }
  return toInlines(items);
}

function parseInlineAt(src: string, depth: number): Inline[] {
  const s = src.replace(/\r\n?/g, "\n");
  const items: Item[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      items.push({ t: "text", v: buf });
      buf = "";
    }
  };
  const noCloser = new Set<number>(); // backtick run lengths that have no closing run in the rest of the text
  const spans = protectedSpans(s);
  const lastBracket = s.lastIndexOf("]");
  let sp = 0;
  let i = 0;
  while (i < s.length) {
    while (sp < spans.length && spans[sp][1] <= i) sp++;
    if (sp < spans.length && spans[sp][0] <= i) {
      buf += s.slice(i, spans[sp][1]); // a URL or path: literal, never a delimiter or an escape
      i = spans[sp][1];
      continue;
    }
    const c = s[i];

    if (c === "\\") {
      const n = s[i + 1];
      if (n !== undefined && ASCII_PUNCT.includes(n)) {
        buf += n;
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }

    if (c === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const n = j - i;
      let end = -1;
      if (!noCloser.has(n)) {
        let k = j;
        while (k < s.length) {
          const p = s.indexOf("`", k);
          if (p < 0) break;
          let q = p;
          while (s[q] === "`") q++;
          if (q - p === n) {
            end = p;
            break;
          }
          k = q;
        }
        if (end < 0) noCloser.add(n);
      }
      if (end >= 0) {
        let v = s.slice(j, end).replace(/\n/g, " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim() !== "") v = v.slice(1, -1);
        flush();
        items.push({ t: "code", v });
        i = end + n;
      } else {
        buf += s.slice(i, j);
        i = j;
      }
      continue;
    }

    if (c === "[") {
      const close = i < lastBracket ? findClosingBracket(s, i) : -1; // no `]` after this point: nothing to scan for
      if (close > 0 && s[close + 1] === "(") {
        const target = parseLinkTarget(s, close + 1);
        if (target) {
          const text = s.slice(i + 1, close);
          flush();
          items.push({ t: "link", href: target.href, c: depth >= MAX_INLINE_DEPTH ? [{ t: "text", v: text }] : parseInlineAt(text, depth + 1) });
          i = target.end;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (s[j] === c) j++;
      const n = j - i;
      if (c === "~" && n !== 2) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      const prev = i > 0 ? s[i - 1] : " ";
      const next = j < s.length ? s[j] : " ";
      const pw = isWs(prev);
      const nw = isWs(next);
      const pp = isPunct(prev);
      const np = isPunct(next);
      const left = !nw && (!np || pw || pp);
      const right = !pw && (!pp || nw || np);
      let open: boolean;
      let close: boolean;
      if (c === "_") {
        open = left && (!right || pp);
        close = right && (!left || np);
        // `__init__.py`: an underscore run followed by a dot and a letter or digit ends a filename, not emphasis.
        if (next === "." && j + 1 < s.length && isAlnum(s[j + 1])) close = false;
      } else {
        open = left;
        close = right;
        // `2*3*4` is arithmetic, not emphasis: a `*` between two letters or digits is literal.
        if (c === "*" && isAlnum(prev) && isAlnum(next)) open = close = false;
      }
      if (open || close) {
        flush();
        items.push({ kind: "delim", ch: c, count: n, orig: n, open, close });
      } else {
        buf += s.slice(i, j);
      }
      i = j;
      continue;
    }

    if (c === "\n") {
      let e = buf.length;
      while (e > 0 && (buf[e - 1] === " " || buf[e - 1] === "\t")) e--;
      buf = buf.slice(0, e);
      flush();
      items.push({ t: "br" });
      i++;
      while (s[i] === " " || s[i] === "\t") i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return resolveEmphasis(items);
}

export function parseInline(src: string): Inline[] {
  try {
    return parseInlineAt(src, 0);
  } catch {
    return src ? [{ t: "text", v: src }] : [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

const blank = (l: string) => l.trim() === "";
const indentOf = (l: string) => l.length - l.trimStart().length;

interface Fence {
  ch: string;
  len: number;
  indent: number;
  lang: string;
}

function openFence(line: string): Fence | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const info = m[3].trim();
  if (m[2][0] === "`" && info.includes("`")) return null;
  return { ch: m[2][0], len: m[2].length, indent: m[1].length, lang: info.split(/\s+/)[0] ?? "" };
}

function closesFence(line: string, f: Fence): boolean {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!m && m[1][0] === f.ch && m[1].length >= f.len;
}

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/**
 * An ATX heading, parsed by scanning (a regex with a lazy group backtracks quadratically on long whitespace runs).
 * The `#` run needs a space after it; an optional closing `#` run is dropped when a space precedes it.
 */
function parseHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let j = i;
  while (line[j] === "#") j++;
  const level = j - i;
  if (level < 1 || level > 6) return null;
  if (j < line.length && line[j] !== " " && line[j] !== "\t") return null;
  let text = line.slice(j).trim();
  let e = text.length;
  while (e > 0 && text[e - 1] === "#") e--;
  if (e < text.length && (e === 0 || text[e - 1] === " " || text[e - 1] === "\t")) text = text.slice(0, e).trimEnd();
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text };
}

const isHeading = (line: string) => parseHeading(line) !== null;
const QUOTE = /^ {0,3}>/;

interface ListStart {
  indent: number;
  bullet: boolean;
  num: number;
  offset: number;
  content: string;
}

function listStart(line: string): ListStart | null {
  const m = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/.exec(line);
  if (!m) return null;
  const marker = m[2];
  const gap = m[3] ?? "";
  const content = m[4] ?? "";
  const spaces = content === "" || gap.length > 4 ? 1 : gap.length;
  return {
    indent: m[1].length,
    bullet: marker.length === 1,
    num: marker.length === 1 ? 0 : parseInt(marker, 10),
    offset: m[1].length + marker.length + spaces,
    content: gap.length > 4 ? gap.slice(1) + content : content,
  };
}

/** The cells of a table row; with a limit, scanning stops once that many cells are in hand. */
function splitRow(line: string, limit = Infinity): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && i + 1 < t.length) {
      cur += c + t[i + 1];
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      if (cells.length >= limit) return cells;
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) return false;
  return splitRow(line).every((c) => /^:?-+:?$/.test(c));
}

function tableStartsAt(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  if (head === undefined || sep === undefined || !head.includes("|") || !isSeparatorRow(sep)) return false;
  return splitRow(head).length === splitRow(sep).length;
}

function interruptsParagraph(lines: string[], i: number): boolean {
  const line = lines[i];
  if (blank(line) || openFence(line) || isHeading(line) || HR.test(line) || QUOTE.test(line)) return true;
  const ls = listStart(line);
  if (ls && ls.indent < 4 && ls.content !== "" && (ls.bullet || ls.num === 1)) return true;
  return tableStartsAt(lines, i);
}

function startsOtherBlock(line: string): boolean {
  return !!openFence(line) || isHeading(line) || HR.test(line) || QUOTE.test(line);
}

function parseList(lines: string[], from: number, depth: number): { block: Block; next: number } {
  const first = listStart(lines[from]) as ListStart;
  const base = first.indent;
  const items: string[][] = [];
  let cur: string[] = [];
  let offset = first.offset;
  let fence: Fence | null = null;
  const add = (line: string) => {
    cur.push(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else fence = openFence(line);
  };
  const strip = (line: string) => line.slice(Math.min(indentOf(line), offset));

  let i = from;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (fence) {
      add(strip(line)); // everything up to the closing fence belongs to the item, blank or not
      i++;
      continue;
    }
    if (blank(line)) {
      let j = i;
      while (j < n && blank(lines[j])) j++;
      if (j >= n) break;
      const next = lines[j];
      const rel = indentOf(next) - base;
      const st = listStart(next);
      const continues = rel >= 2 || (rel < 2 && st !== null && st.bullet === first.bullet && !HR.test(next));
      if (!continues) break;
      for (let b = i; b < j; b++) add("");
      i = j;
      continue;
    }
    const rel = indentOf(line) - base;
    const st = listStart(line);
    if (st && rel < 2) {
      if (st.bullet !== first.bullet || HR.test(line)) break;
      cur = [];
      items.push(cur);
      offset = st.offset;
      fence = null;
      add(st.content);
      i++;
      continue;
    }
    if (items.length === 0) {
      // the first line of the list is always a marker line, so this cannot happen; guard anyway
      break;
    }
    if (rel >= 2) {
      add(strip(line));
      i++;
      continue;
    }
    if (cur.at(-1) !== "" && !startsOtherBlock(line)) {
      add(line.trimStart());
      i++;
      continue;
    }
    break;
  }
  const block: Block = {
    t: first.bullet ? "ul" : "ol",
    ...(!first.bullet && first.num !== 1 ? { start: first.num } : {}),
    items: items.map((it) => parseBlocksAt(it, depth + 1)),
  };
  return { block, next: i };
}

function parseTable(lines: string[], from: number): { block: Block; next: number } {
  const head = splitRow(lines[from], MAX_TABLE_COLUMNS);
  const sep = splitRow(lines[from + 1], MAX_TABLE_COLUMNS);
  const align = sep.map((c): "left" | "center" | "right" | null => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  const width = head.length;
  const rows: Inline[][][] = [];
  let i = from + 2;
  while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !openFence(lines[i]) && !isHeading(lines[i])) {
    // Rows past the cap are consumed but dropped, without being split.
    if (rows.length < MAX_TABLE_ROWS) {
      const cells = splitRow(lines[i], width);
      while (cells.length < width) cells.push("");
      rows.push(cells.slice(0, width).map(parseInline));
    }
    i++;
  }
  return { block: { t: "table", head: head.map(parseInline), rows, align }, next: i };
}

function parseBlocksAt(lines: string[], depth: number): Block[] {
  if (depth > MAX_BLOCK_DEPTH) {
    const text = lines.map((l) => l.trim()).join("\n").trim();
    return text ? [{ t: "p", c: parseInline(text) }] : [];
  }
  const out: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = openFence(line);
    if (fence) {
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < n) {
        if (closesFence(lines[i], fence)) {
          closed = true;
          i++;
          break;
        }
        const l = lines[i];
        body.push(l.slice(Math.min(fence.indent, indentOf(l))));
        i++;
      }
      out.push({ t: "code", lang: fence.lang, v: body.join("\n"), closed });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      out.push({ t: "h", level: heading.level, c: parseInline(heading.text) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < n && QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push({ t: "quote", c: parseBlocksAt(inner, depth + 1) });
      continue;
    }

    if (tableStartsAt(lines, i)) {
      const { block, next } = parseTable(lines, i);
      out.push(block);
      i = next;
      continue;
    }

    if (listStart(line)) {
      const { block, next } = parseList(lines, i, depth);
      out.push(block);
      i = next;
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < n && !interruptsParagraph(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

export function parseMarkdown(src: string): Block[] {
  try {
    return parseBlocksAt(src.replace(/\r\n?/g, "\n").split("\n"), 0);
  } catch {
    return src.trim() ? [{ t: "p", c: [{ t: "text", v: src }] }] : [];
  }
}

/** How deeply emphasis and links nest in an inline tree: 0 for flat text, 1 for a bold word, and so on. Iterative, so a deep tree cannot overflow the stack. */
export function maxInlineDepth(nodes: Inline[]): number {
  let max = 0;
  const stack: { list: Inline[]; d: number }[] = [{ list: nodes, d: 0 }];
  for (let top = stack.pop(); top; top = stack.pop()) {
    for (const n of top.list) {
      if ("c" in n) {
        max = Math.max(max, top.d + 1);
        stack.push({ list: n.c, d: top.d + 1 });
      }
    }
  }
  return max;
}

export function inlinePlainText(nodes: Inline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text" || n.t === "code") out += n.v;
    else if (n.t === "br") out += "\n";
    else out += inlinePlainText(n.c);
  }
  return out;
}

/** A block as plain text, for the fallback shown when building its elements fails. Never throws. */
export function blockPlainText(b: Block): string {
  try {
    switch (b.t) {
      case "p":
      case "h":
        return inlinePlainText(b.c);
      case "code":
        return b.v;
      case "quote":
        return b.c.map(blockPlainText).join("\n");
      case "ul":
      case "ol":
        return b.items.map((item) => item.map(blockPlainText).join("\n")).join("\n");
      case "hr":
        return "---";
      case "table":
        return [b.head, ...b.rows].map((row) => row.map(inlinePlainText).join(" | ")).join("\n");
    }
  } catch {
    return "";
  }
}

/**
 * The paths a rendered markdown text links in the window, in reading order: the one definition the server's allow-list shares
 * with ui/markdown-dom.ts, so a link the window shows is always a path the server allows. It follows the same rules as the
 * DOM builder: text is read by tokenize, an inline code span by tokenizeCode, a fenced block line by line (tokenizeFenceBody),
 * and nothing inside the text of a link (a link with a usable target has no links in it; an unusable one shows its text as
 * plain text with links, like any other text).
 */
export function markdownPaths(src: string): string[] {
  const out: string[] = [];
  const add = (tokens: { type: string; value: string }[]) => {
    for (const t of tokens) if (t.type === "path") out.push(t.value);
  };
  const inlines = (nodes: Inline[], inLink: boolean): void => {
    for (const n of nodes) {
      switch (n.t) {
        case "text":
          if (!inLink) add(tokenize(n.v));
          break;
        case "code":
          if (!inLink) add(tokenizeCode(n.v));
          break;
        case "strong":
        case "em":
        case "del":
          inlines(n.c, inLink);
          break;
        case "link":
          inlines(n.c, safeHref(n.href) === null || inLink ? inLink : true);
          break;
        case "br":
          break;
      }
    }
  };
  const block = (b: Block): void => {
    switch (b.t) {
      case "p":
      case "h":
        inlines(b.c, false);
        break;
      case "code":
        add(tokenizeFenceBody(b.v));
        break;
      case "quote":
        for (const c of b.c) block(c);
        break;
      case "ul":
      case "ol":
        for (const item of b.items) for (const c of item) block(c);
        break;
      case "table":
        for (const cell of b.head) inlines(cell, false);
        for (const row of b.rows) for (const cell of row) inlines(cell, false);
        break;
      case "hr":
        break;
    }
  };
  for (const b of parseMarkdown(src)) block(b);
  return out;
}
