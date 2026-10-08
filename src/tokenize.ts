export interface Token {
  type: "text" | "url" | "path";
  value: string;
  /**
   * Only on a path: it has no file extension (or ends in a separator), so it may be a folder. The window cannot know
   * whether it exists, so it links it as a folder and the server decides on the click (src/dirs.ts).
   */
  dir?: true;
}

const urlPattern = String.raw`https?:\/\/[^\s<>"'\x60)\]]*[^\s<>"'\x60)\].,;:!?]`;
// A path may end in one separator (`C:\Users\x\folder\`): that is how a folder is often written.
const winPattern = String.raw`[A-Za-z]:\\(?:[^\\/:*?"<>|\s\x60]+\\)*[^\\/:*?"<>|\s\x60]+\\?`;
// `C:/Users/x/folder`: unlike the backslash form it must not start inside a word (`etc:/a/b`) or after a slash (`file:///C:/x`), since `/` and `:` are common in prose.
const winSlashPattern = String.raw`(?<![\p{L}\p{N}_/.:-])[A-Za-z]:\/(?:[^\\/:*?"<>|\s\x60]+[\\/])*[^\\/:*?"<>|\s\x60]+[\\/]?`;
// Letters and digits of any script (`~/Documenti/Città`), not only ASCII word characters. A format character (bidi control, zero
// width) is let through the pattern on purpose and the match is dropped afterwards: a token that holds one is not a path at all,
// and stopping the pattern before it would give another path.
const posixPattern = String.raw`(?<![\p{L}\p{N}_/.:-])~?(?:\/[\p{L}\p{N}\p{M}\p{Cf}_.@+-]+)+\/?`;
const RE = new RegExp(`(${urlPattern})|(${winPattern}|${winSlashPattern})|(${posixPattern})`, "gu");

/**
 * Drop sentence punctuation and closing brackets or quotes that belong to the surrounding text, not the path. The brackets
 * are counted once and adjusted as characters are dropped, so a long run of `)` or `]` after a path is one linear pass
 * (counting again after every character was quadratic).
 */
function trimPath(value: string): string {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 40 /* ( */) openParen++;
    else if (c === 41 /* ) */) closeParen++;
    else if (c === 91 /* [ */) openBracket++;
    else if (c === 93 /* ] */) closeBracket++;
  }
  let end = value.length;
  while (end > 0) {
    const c = value[end - 1]!;
    if (".,;:!?'".includes(c)) end--;
    else if (c === ")" && openParen < closeParen) {
      closeParen--;
      end--;
    } else if (c === "]" && openBracket < closeBracket) {
      closeBracket--;
      end--;
    } else break;
  }
  return end === value.length ? value : value.slice(0, end);
}

/** A POSIX match is a path when it has two segments, or one with a dot; `/morning` is a slash command, not a path. */
function isPosixPath(value: string): boolean {
  if (value.startsWith("~")) return true;
  const segments = value.split("/").filter(Boolean);
  return segments.length >= 2 || (segments.length === 1 && segments[0].includes("."));
}

/** Longest extension a file name has, in characters (`.pptx`, `.webp`; not a sentence after a dot). */
const MAX_EXTENSION = 10;

/**
 * Whether an absolute path, as tokenize found it, may be a folder: it ends in a separator, or its last segment has no
 * extension. An extension is a dot followed by 1 to 10 letters or digits with at least one letter, so `notes.md` and
 * `my.project` are files, while `.claude`, `v1.2` and `shot(1)` are not. One scan over the last segment, linear.
 */
export function looksLikeDirectory(path: string): boolean {
  const end = path.length;
  if (end === 0) return false;
  const last = path.charCodeAt(end - 1);
  if (last === 47 /* / */ || last === 92 /* \ */) return true;
  let start = end;
  while (start > 0) {
    const c = path.charCodeAt(start - 1);
    if (c === 47 || c === 92) break;
    start--;
  }
  let dot = -1;
  for (let i = end - 1; i > start; i--) {
    if (path.charCodeAt(i) === 46 /* . */) {
      dot = i;
      break;
    }
  }
  if (dot < 0) return true; // no dot after the first character: a leading dot alone (`.claude`) is not an extension
  const len = end - dot - 1;
  if (len < 1 || len > MAX_EXTENSION) return true;
  let letter = false;
  for (let i = dot + 1; i < end; i++) {
    const c = path.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letter = true;
    else if (c < 48 || c > 57) return true; // not alphanumeric: not an extension
  }
  return !letter;
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit paths: a path whose end is told by a delimiter, so it may hold spaces.

/** The longest path a token may hold, in characters (the same limit /api/open puts on a folder target). */
export const MAX_TOKEN = 4096;

const isWs = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a);
const isLetterOrDigit = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c > 127 && /[\p{L}\p{N}]/u.test(String.fromCharCode(c)));

/** Unicode format characters (category Cf): bidi controls, zero-width characters, the soft hyphen, the BOM. They make a name read as another one. */
const FORMAT = /\p{Cf}/u;

/** True when the text holds a Unicode format character (see FORMAT). Used by the tokenizer and by the server's checks on a target. */
export function hasFormatChar(s: string): boolean {
  return FORMAT.test(s);
}

/** Characters that are never inside a path written between delimiters: controls, line separators, the backtick, `" < > | ? *`, and the format characters of the BMP. */
function isBadPathChar(c: number): boolean {
  if (c < 32 || c === 127 || c === 96 || c === 34 || c === 60 || c === 62 || c === 124 || c === 63 || c === 42) return true;
  if (c < 0xa0) return false;
  return (
    c === 0x85 || c === 0xad || c === 0x2028 || c === 0x2029 || c === 0x061c || c === 0x06dd || c === 0x070f || c === 0x180e || c === 0xfeff ||
    (c >= 0x0600 && c <= 0x0605) || (c >= 0x0890 && c <= 0x0891) || c === 0x08e2 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) || (c >= 0xfff9 && c <= 0xfffb)
  );
}

/**
 * The [start, end) of the path that is the WHOLE trimmed content of text[from, to), or null. An absolute path: a drive letter
 * and `:\` or `:/` (then at least one segment), `~/` (one segment) or a leading `/` (two segments). Spaces and any other
 * letters are allowed inside, but a segment never starts or ends with white space (so `/a/b and /c/d` is not one path), there
 * are no empty segments (so no `//server/share`, no `C:\\x`), a Windows path has no further `:`, a POSIX one no backslash, and
 * the whole is at most MAX_TOKEN characters and does not end in sentence punctuation. One pass, and it stops at the first reason to refuse.
 */
export function wholePathRange(text: string, from: number, to: number): [number, number] | null {
  let s = from;
  let e = to;
  while (s < e && isWs(text.charCodeAt(s))) s++;
  while (e > s && isWs(text.charCodeAt(e - 1))) e--;
  const len = e - s;
  if (len < 3 || len > MAX_TOKEN) return null;
  // A closing dot, comma, semicolon, colon or exclamation mark is the sentence's, as in the plain patterns (and Windows drops a
  // trailing dot): the plain patterns decide then, so a span like `/a/b.` still gives /a/b, as it did.
  const last = text.charCodeAt(e - 1);
  if (last === 46 || last === 44 || last === 59 || last === 58 || last === 33) return null;
  const c0 = text.charCodeAt(s);
  const c1 = text.charCodeAt(s + 1);
  const c2 = text.charCodeAt(s + 2);
  let windows = false;
  let first: number; // where the first segment starts
  let needed: number;
  if (((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) && c1 === 58 && (c2 === 92 || c2 === 47)) {
    windows = true;
    first = s + 3;
    needed = 1;
  } else if (c0 === 126 && c1 === 47) {
    first = s + 2;
    needed = 1;
  } else if (c0 === 47) {
    first = s + 1;
    needed = 2;
  } else return null;
  let segStart = first;
  let segments = 0;
  for (let i = first; i <= e; i++) {
    const c = i < e ? text.charCodeAt(i) : -1;
    if (i < e) {
      if (isBadPathChar(c)) return null;
      if (c === 58 || (!windows && c === 92)) return null; // a stray colon is an alternate data stream on Windows: refused everywhere, so the window and the server agree
      if (c >= 0xd800 && c <= 0xdbff && FORMAT.test(text.slice(i, i + 2))) return null; // a format character outside the BMP (the tag characters)
    }
    if (i === e || c === 47 || (windows && c === 92)) {
      if (i === segStart) {
        if (i === e && segments > 0) break; // a trailing separator
        return null; // an empty segment
      }
      if (isWs(text.charCodeAt(segStart)) || isWs(text.charCodeAt(i - 1))) return null;
      segments++;
      segStart = i + 1;
    }
  }
  return segments >= needed ? [s, e] : null;
}

const DELIMITER = /[`~"'\u201c\u2018]/;

/** [start, end) pairs of explicit paths, ascending and not overlapping, in a flat array. */
function explicitSpans(text: string): number[] {
  const out: number[] = [];
  if (!DELIMITER.test(text)) return out; // nothing that could end a path: the common case costs one scan
  const n = text.length;
  let fence: { ch: number; len: number } | null = null;
  let pos = 0;
  while (pos <= n) {
    let le = text.indexOf("\n", pos);
    if (le < 0) le = n;
    let i = pos;
    while (i < le && isWs(text.charCodeAt(i))) i++;
    if (fence) {
      let k = i;
      while (k < le && text.charCodeAt(k) === fence.ch) k++;
      let rest = k;
      while (rest < le && isWs(text.charCodeAt(rest))) rest++;
      if (k - i >= fence.len && rest === le) fence = null;
      else {
        const r = wholePathRange(text, pos, le);
        if (r) out.push(r[0], r[1]);
      }
    } else {
      const ch = i < le ? text.charCodeAt(i) : 0;
      let opened = false;
      if (ch === 96 || ch === 126) {
        let k = i;
        while (k < le && text.charCodeAt(k) === ch) k++;
        if (k - i >= 3) {
          // the info string of a backtick fence has no backtick
          let ok = true;
          if (ch === 96) {
            for (let j = k; j < le; j++) {
              if (text.charCodeAt(j) === 96) {
                ok = false;
                break;
              }
            }
          }
          if (ok) {
            fence = { ch, len: k - i };
            opened = true;
          }
        }
      }
      if (!opened) inlineSpans(text, pos, le, out);
    }
    pos = le + 1;
  }
  return out;
}

const DQ = 34;
const LDQ = 0x201c;
const RDQ = 0x201d;
const SQ = 39;
const LSQ = 0x2018;
const RSQ = 0x2019;

/** Where the nearest closer of a quote stands, found from `from` (-1: none before `limit`, -2: not scanned yet). */
interface CloserCache {
  from: number;
  at: number;
  limit: number;
}

/**
 * The explicit paths of one line, left to right, each delimiter pairing once: code spans (a run of backticks closed by the next
 * run of the same length), double quotes, typographic quotes and single quotes. A pair is consumed whether or not its
 * content is a path, so a quote inside a code span is never read twice. A quote never reaches across a backtick: its closer
 * search stops there (a path cannot hold a backtick anyway), so a quote pair never swallows a code span, which is then paired
 * on its own, as the markdown parser of the window does. A single quote opens after a character that is not a letter or digit
 * and closes before one (an apostrophe, `Alex's`, closes nothing). Linear: the backtick runs are indexed once, a closer is
 * searched from the opener to the nearest closer or backtick, and a search is kept (`CloserCache`) for the openers it also covers.
 */
function inlineSpans(text: string, ls: number, le: number, out: number[]): void {
  let runStart: number[] | null = null;
  const runLen: number[] = [];
  let byLen: Map<number, number[]> | null = null;
  const cursor = new Map<number, number>();
  let ri = 0;
  const dq: CloserCache = { from: -1, at: -2, limit: -1 };
  const ldq: CloserCache = { from: -1, at: -2, limit: -1 };
  const sq: CloserCache = { from: -1, at: -2, limit: -1 };
  const lsq: CloserCache = { from: -1, at: -2, limit: -1 };

  const push = (a: number, b: number) => {
    const r = wholePathRange(text, a, b);
    if (r) out.push(r[0], r[1]);
  };
  const closer = (i: number, code: number, boundary: boolean, cache: CloserCache): number => {
    if (cache.at !== -2 && i >= cache.from && (cache.at > i || (cache.at === -1 && i < cache.limit))) return cache.at;
    cache.at = -1;
    cache.from = i;
    let j = i + 1;
    for (; j < le; j++) {
      const c = text.charCodeAt(j);
      if (c === 96) break;
      if (c === code && (!boundary || j + 1 >= le || !isLetterOrDigit(text.charCodeAt(j + 1)))) {
        cache.at = j;
        break;
      }
    }
    cache.limit = j;
    return cache.at;
  };

  let i = ls;
  while (i < le) {
    const c = text.charCodeAt(i);
    if (c === 96) {
      if (runStart === null) {
        runStart = [];
        byLen = new Map();
        for (let j = ls; j < le; ) {
          if (text.charCodeAt(j) !== 96) {
            j++;
            continue;
          }
          let k = j;
          while (k < le && text.charCodeAt(k) === 96) k++;
          const list = byLen.get(k - j);
          if (list) list.push(runStart.length);
          else byLen.set(k - j, [runStart.length]);
          runStart.push(j);
          runLen.push(k - j);
          j = k;
        }
      }
      while (ri < runStart.length && runStart[ri] < i) ri++;
      const n = runLen[ri];
      const list = byLen!.get(n)!;
      let cur = cursor.get(n) ?? 0;
      while (cur < list.length && list[cur] <= ri) cur++;
      cursor.set(n, cur);
      if (cur < list.length) {
        const close = list[cur];
        push(i + n, runStart[close]);
        i = runStart[close] + runLen[close];
        ri = close + 1;
      } else {
        i += n;
        ri++;
      }
      continue;
    }
    let j = -1;
    if (c === DQ) j = closer(i, DQ, false, dq);
    else if (c === LDQ) j = closer(i, RDQ, false, ldq);
    else if ((c === SQ || c === LSQ) && (i === ls || !isLetterOrDigit(text.charCodeAt(i - 1)))) {
      j = c === SQ ? closer(i, SQ, true, sq) : closer(i, RSQ, true, lsq);
    }
    if (j < 0) i++;
    else {
      push(i + 1, j);
      i = j + 1;
    }
  }
}

export function tokenize(text: string): Token[] {
  return scan(text, true);
}

/** The tokens of a text: the plain patterns, plus (when `explicit`) the paths that a delimiter ends, which win over a match they overlap. */
function scan(text: string, explicit: boolean): Token[] {
  const spans = explicit ? explicitSpans(text) : [];
  const out: Token[] = [];
  let last = 0;
  let si = 0;
  const emitSpan = (a: number, b: number) => {
    if (a < last) return;
    if (a > last) out.push({ type: "text", value: text.slice(last, a) });
    out.push(pathToken(text.slice(a, b)));
    last = b;
  };
  for (const m of text.matchAll(RE)) {
    const type = m[1] ? "url" : "path";
    let value = m[0];
    if (type === "path") {
      value = trimPath(value);
      if (m[3] && !isPosixPath(value)) continue;
      if (FORMAT.test(value)) continue; // a format character in a path: not a path at all
      // The Windows patterns stop at white space, and U+FEFF is white space to a regex: a format character right after the match
      // is then still part of the name, so the whole match goes (keeping the prefix would link another file than the one shown).
      const next = (m.index ?? 0) + m[0].length;
      if (next < text.length && FORMAT.test(String.fromCodePoint(text.codePointAt(next)!))) continue;
    }
    const start = m.index ?? 0;
    const end = start + value.length;
    // Explicit paths that lie before this match come first; one that overlaps it wins and the match is dropped.
    let overlapped = false;
    while (si < spans.length && spans[si] < end) {
      if (spans[si + 1] <= start) {
        emitSpan(spans[si], spans[si + 1]);
        si += 2;
      } else {
        overlapped = true;
        break;
      }
    }
    if (overlapped) continue;
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    out.push(type === "path" ? pathToken(value) : { type, value });
    last = end;
  }
  for (; si < spans.length; si += 2) emitSpan(spans[si], spans[si + 1]);
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function pathToken(value: string): Token {
  return looksLikeDirectory(value) ? { type: "path", value, dir: true } : { type: "path", value };
}

/**
 * The tokens of the content of an inline code span, which the markdown parser has already cut out of its backticks: the
 * whole content when it is one path (spaces allowed), otherwise what the plain patterns find. Quotes inside a code span
 * are text, as they are for the server, which reads the span as one unit.
 */
export function tokenizeCode(code: string): Token[] {
  const r = wholePathRange(code, 0, code.length);
  if (!r) return scan(code, false);
  const out: Token[] = [];
  if (r[0] > 0) out.push({ type: "text", value: code.slice(0, r[0]) });
  out.push(pathToken(code.slice(r[0], r[1])));
  if (r[1] < code.length) out.push({ type: "text", value: code.slice(r[1]) });
  return out;
}

/**
 * The tokens of the body of a fenced code block: every line that is, trimmed, one absolute path is a path token (spaces
 * allowed), everything else, line breaks included, is text. The same lines the server reads inside a fence.
 */
export function tokenizeFenceBody(body: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  let pos = 0;
  while (pos <= body.length) {
    let le = body.indexOf("\n", pos);
    if (le < 0) le = body.length;
    const r = wholePathRange(body, pos, le);
    if (r) {
      if (r[0] > last) out.push({ type: "text", value: body.slice(last, r[0]) });
      out.push(pathToken(body.slice(r[0], r[1])));
      last = r[1];
    }
    pos = le + 1;
  }
  if (last < body.length) out.push({ type: "text", value: body.slice(last) });
  return out;
}
