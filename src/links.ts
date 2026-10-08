import { homedir } from "node:os";
import { join } from "node:path";
import { markdownPaths } from "../ui/markdown";
import { tokenize } from "./tokenize";
import type { Exchange } from "./transcript/parse";

export { MAX_TOKEN, hasFormatChar, looksLikeDirectory, tokenize, tokenizeCode, tokenizeFenceBody, wholePathRange, type Token } from "./tokenize";

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * The paths a text shows as links, as written. Assistant text is rendered as markdown by the window, so it is read by the
 * window's own parser (markdownPaths): a code span, a quote or a fence is then the same thing on both sides. A user's text is
 * shown as plain text, so it is read by the tokenizer.
 */
export function textPaths(text: string, markdown: boolean): string[] {
  if (markdown) {
    try {
      return markdownPaths(text);
    } catch {
      /* the window falls back to plain text for a block it cannot build: the tokenizer is then a superset */
    }
  }
  const out: string[] = [];
  for (const t of tokenize(text)) if (t.type === "path") out.push(t.value);
  return out;
}

/**
 * The paths of the conversation's text blocks: files and folder candidates alike (a folder is a path with no extension,
 * see Token.dir), in the form they were written, `~/` expanded. They make up the allow-list of /api/file and /api/open.
 */
export function collectPaths(exchanges: Exchange[]): string[] {
  const found = new Set<string>();
  for (const ex of exchanges) {
    for (const [blocks, markdown] of [[ex.user, false], [ex.assistant, true]] as const) {
      for (const block of blocks) {
        if (block.kind !== "text") continue;
        for (const p of textPaths(block.text, markdown)) found.add(expandHome(p));
      }
    }
  }
  return [...found];
}
