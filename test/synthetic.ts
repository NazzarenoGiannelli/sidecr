/**
 * Synthetic Claude Code transcripts for the history tests: every kind of row the parser cares about (prompts, queued
 * messages and their twins, tool results, side chains, meta rows, interrupt markers, inline images, multi-row
 * assistant messages with usage), deterministic from a seed.
 */

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface SynthOptions {
  seed?: number;
  /** Extra filler per assistant text row, in characters (to make big files). */
  filler?: number;
  /** Image paths to mention now and then (they end up in the allow-list). */
  paths?: string[];
  /** URLs to mention now and then. */
  urls?: string[];
  /** Leave the uuid off prompt rows. */
  noUuid?: boolean;
}

/** `rows` JSONL rows (each a JSON string, no newline). */
export function synthRows(rows: number, opts: SynthOptions = {}): string[] {
  const r = rng(opts.seed ?? 1);
  const out: string[] = [];
  let n = 0;
  let t = Date.UTC(2026, 9, 1, 8, 0, 0);
  const ts = () => new Date((t += 1000 + Math.floor(r() * 5000))).toISOString();
  const filler = opts.filler ?? 0;
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const push = (o: object) => out.push(JSON.stringify(o));
  let msg = 0;
  while (out.length < rows) {
    n++;
    const kind = r();
    const uuid = opts.noUuid ? undefined : `u-${n}`;
    if (kind < 0.05 && n > 1) {
      // A queued message: attachment row then, a couple of rows later, its twin user row.
      const text = `queued ${n}`;
      push({ type: "attachment", uuid: `q-${n}`, timestamp: ts(), attachment: { type: "queued_command", commandMode: "prompt", prompt: text } });
      push({ type: "assistant", timestamp: ts(), message: { id: `m${++msg}`, role: "assistant", content: [{ type: "text", text: `working on ${n}` }], usage: { input_tokens: 3, output_tokens: 2 } } });
      push({ type: "user", uuid: `qt-${n}`, promptSource: "queued", timestamp: ts(), message: { role: "user", content: text } });
      continue;
    }
    if (kind < 0.08) {
      push({ type: "user", isSidechain: true, uuid: `side-${n}`, message: { role: "user", content: "side chain" } });
      continue;
    }
    if (kind < 0.1) {
      push({ type: "user", isMeta: true, uuid: `meta-${n}`, message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" } });
      continue;
    }
    if (kind < 0.12) {
      push({ type: "user", uuid: `int-${n}`, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      continue;
    }
    // A prompt, sometimes with an image block or a path or a URL.
    const content: object[] = [{ type: "text", text: `prompt ${n}${opts.paths && r() < 0.2 ? ` see ${pick(opts.paths)}` : ""}${opts.urls && r() < 0.2 ? ` at ${pick(opts.urls)}` : ""}` }];
    if (r() < 0.05) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } });
    push({ type: "user", ...(uuid ? { uuid } : {}), timestamp: ts(), message: { role: "user", content } });
    // The answer: 1 to 4 rows, sometimes one message id over two rows, tool calls and their results in between.
    const parts = 1 + Math.floor(r() * 4);
    for (let i = 0; i < parts; i++) {
      const id = `m${++msg}`;
      if (r() < 0.5) {
        push({ type: "assistant", timestamp: ts(), message: { id, role: "assistant", content: [{ type: "tool_use", id: `t${msg}`, name: "Read", input: { file_path: `/repo/file${n}.ts` } }], usage: { input_tokens: 10, output_tokens: 5 } } });
        push({ type: "user", timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${msg}`, content: "x".repeat(50 + Math.floor(r() * 200)) }] } });
      } else {
        const text = `answer ${n}.${i}${opts.urls && r() < 0.3 ? ` (${pick(opts.urls)})` : ""} ${"y".repeat(filler)}`;
        push({ type: "assistant", timestamp: ts(), message: { id, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 20, output_tokens: 7 } } });
        if (r() < 0.3) push({ type: "assistant", timestamp: ts(), message: { id, role: "assistant", content: [{ type: "text", text: "more" }], usage: { input_tokens: 20, output_tokens: 9 } } });
      }
    }
  }
  return out.slice(0, rows);
}

export const toJsonl = (rows: string[]): string => rows.map((x) => `${x}\n`).join("");
