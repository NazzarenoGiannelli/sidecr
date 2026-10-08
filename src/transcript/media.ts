/**
 * What an exchange shares that the Media & Links panel lists: images (pasted image blocks, and image paths in the
 * text, the same paths the conversation shows thumbnails for) and links (http/https URLs in the user's and Claude's
 * text and in the tool summaries the conversation shows). Pure: tokenizes the parsed exchange, no file access.
 */
import { isImagePath } from "../imagepath";
import { textPaths } from "../links";
import { tokenize } from "../tokenize";
import type { Exchange } from "./parse";

export interface FoundImage {
  kind: "block" | "path";
  /** For a block: its index among the user's blocks (the /api/image `block` is `u<i>`). */
  block?: number;
  /** For a path: as written in the text (the window's /api/file URL uses it as is; the server expands "~/"). */
  path?: string;
}

export interface FoundLink {
  url: string;
  /** The URL without its fragment, the host in lower case: what duplicates are recognised by. */
  norm: string;
  host: string;
  /** A few words around the link, plain text (the link text of a Markdown link, else the words before it). */
  title?: string;
}

const MAX_TITLE_CHARS = 80;
const TITLE_WORDS = 8;

/** The normalised form of an http(s) URL, or null when it is not one. */
export function normaliseUrl(raw: string): { norm: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return { norm: `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`, host: u.hostname.toLowerCase() };
}

const clean = (s: string): string =>
  s
    .replace(/https?:\/\/\S*/g, " ") // another link on the same line is not a title
    .replace(/[`*_#>|~[\]()<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function cap(s: string): string | undefined {
  const t = s.length > MAX_TITLE_CHARS ? `${s.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : s;
  return t || undefined;
}

/** The words around a URL that starts at `start` and ends at `end` in `text`. */
export function titleAround(text: string, start: number, end: number): string | undefined {
  // [link text](https://…): the link text.
  if (start >= 2 && text.slice(start - 2, start) === "](") {
    const open = text.lastIndexOf("[", start - 2);
    if (open >= 0 && start - 2 - open <= 200) {
      const t = clean(text.slice(open + 1, start - 2));
      if (t) return cap(t);
    }
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  const before = clean(text.slice(Math.max(lineStart, start - 200), start).replace(/\S*$/, ""))
    .replace(/[:\-–—,;(]+$/, "")
    .trim();
  const words = before.replace(/^[:\-–—,;.]+\s*/, "").split(" ").filter(Boolean);
  if (words.length) return cap(words.slice(-TITLE_WORDS).join(" "));
  const after = clean(text.slice(end, Math.min(lineEnd, end + 200))).replace(/^[:\-–—,;)]+/, "").trim();
  const next = after.split(" ").filter(Boolean);
  return next.length ? cap(next.slice(0, TITLE_WORDS).join(" ")) : undefined;
}

function linksIn(text: string, out: FoundLink[]): void {
  let at = 0;
  for (const t of tokenize(text)) {
    const start = text.indexOf(t.value, at);
    const end = start + t.value.length;
    if (start >= 0) at = end;
    if (t.type !== "url") continue;
    const n = normaliseUrl(t.value);
    if (!n) continue;
    const title = start >= 0 ? titleAround(text, start, end) : undefined;
    out.push({ url: t.value, ...n, ...(title ? { title } : {}) });
  }
}

/** The images and links of one exchange, in reading order. */
export function collectMedia(ex: Exchange): { images: FoundImage[]; links: FoundLink[] } {
  const images: FoundImage[] = [];
  const links: FoundLink[] = [];
  // The paths the window links, read the way it renders the text: assistant text as markdown, a user's text as plain text.
  const paths = (text: string, markdown: boolean) => {
    for (const p of textPaths(text, markdown)) if (isImagePath(p)) images.push({ kind: "path", path: p });
  };
  ex.user.forEach((b, i) => {
    if (b.kind === "image") images.push({ kind: "block", block: i });
    else if (b.kind === "text") {
      paths(b.text, false);
      linksIn(b.text, links);
    }
  });
  for (const b of ex.assistant) {
    if (b.kind === "text") {
      paths(b.text, true);
      linksIn(b.text, links);
    } else if (b.kind === "tools") {
      for (const item of b.items) {
        for (const t of tokenize(item.summary)) {
          if (t.type !== "url" || t.value.endsWith("…")) continue; // a summary cut short cuts its URL too
          const n = normaliseUrl(t.value);
          if (n) links.push({ url: t.value, ...n, ...(item.name ? { title: cap(item.name) } : {}) });
        }
      }
    }
  }
  return { images, links };
}
