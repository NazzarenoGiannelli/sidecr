/**
 * Transcripts with the row shapes that are easy to get wrong at chunk boundaries (from the wave 4C review): queued
 * twins far apart and in both orders, the same queued text repeated, harness and task-notification rows, interruption
 * markers, pasted_content wrappers, tool_result-only rows, side chains, compaction summaries, rows longer than a
 * chunk, raw invalid UTF-8, CRLF, and a truncated last line.
 */
import { writeFileSync } from "node:fs";

let t = Date.UTC(2026, 0, 1);
const ts = () => new Date((t += 1000)).toISOString();
const J = (o: object) => JSON.stringify(o);
const user = (uuid: string, content: unknown, extra: object = {}) => J({ type: "user", uuid, timestamp: ts(), message: { role: "user", content }, ...extra });
let msg = 0;
const asst = (text: string) => J({ type: "assistant", timestamp: ts(), message: { id: `m${++msg}`, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
const toolRes = (size: number) => J({ type: "user", timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r".repeat(size) }] } });
const att = (uuid: string, prompt: string) => J({ type: "attachment", uuid, timestamp: ts(), attachment: { type: "queued_command", commandMode: "prompt", prompt } });

/** `prompts` turns; `gap` bytes of tool output between the two records of each queued message. */
export function adversarialRows(prompts: number, gap: number, opts: { huge?: boolean } = {}): string[] {
  const rows: string[] = [];
  for (let i = 0; i < prompts; i++) {
    rows.push(user(`p${i}`, `prompt ${i}`));
    rows.push(asst(`answer ${i}`));
    if (i % 7 === 0) rows.push(J({ type: "user", uuid: `tn${i}`, origin: { kind: "task-notification" }, timestamp: ts(), message: { role: "user", content: "<task-notification>done</task-notification>" } }));
    if (i % 11 === 0) rows.push(att(`h${i}`, "<system-reminder>x</system-reminder>"));
    if (i % 13 === 0) rows.push(user(`pc${i}`, `<pasted_content id="ab">pasted ${i}</pasted_content id="ab">`));
    if (i % 17 === 0) rows.push(J({ type: "user", uuid: `cs${i}`, isCompactSummary: true, message: { role: "user", content: "summary" } }));
    if (i % 19 === 0) rows.push(J({ type: "summary", summary: "s", leafUuid: "x" }));
    if (i % 23 === 0) rows.push(user(`int${i}`, [{ type: "text", text: "[Request interrupted by user for tool use]" }]));
    if (i % 29 === 0) rows.push(J({ type: "user", isSidechain: true, uuid: `sc${i}`, message: { role: "user", content: "side" } }));
    if (i % 31 === 0) rows.push(user(`bad${i}`, `bad utf8 � here ${i}`)); // made raw invalid bytes by writeAdversarial
    if (i % 5 === 0) {
      const text = `queued ${i % 10}`; // repeats: chains of the same text
      rows.push(att(`q${i}`, text));
      for (let k = 0; k < 6; k++) rows.push(toolRes(Math.ceil(gap / 6)));
      rows.push(user(`qt${i}`, text, { promptSource: "queued" }));
      rows.push(asst(`after queued ${i}`));
    }
    if (i % 9 === 0) {
      const text = `reverse ${i}`; // the user row first, the attachment later
      rows.push(user(`rq${i}`, text, { promptSource: "queued" }));
      rows.push(toolRes(gap));
      rows.push(att(`ra${i}`, text));
    }
    if (opts.huge && i === Math.floor(prompts / 2)) rows.push(asst("H".repeat(3 * 1024 * 1024))); // longer than a chunk
    if (opts.huge && i === Math.floor((prompts * 3) / 4)) rows.push(user("hugeprompt", "P".repeat(2 * 1024 * 1024)));
  }
  return rows;
}

/** Writes the rows (CRLF or LF), turns every U+FFFD into raw invalid bytes, and leaves a truncated row at the end. */
export function writeAdversarial(path: string, rows: string[], crlf: boolean): void {
  let buf = Buffer.from(rows.map((r) => r + (crlf ? "\r\n" : "\n")).join(""), "utf8");
  const bad = Buffer.from([0xef, 0xbf, 0xbd]);
  for (let i = buf.indexOf(bad); i >= 0; i = buf.indexOf(bad, i + 3)) {
    buf[i] = 0xff;
    buf[i + 1] = 0xfe;
    buf[i + 2] = 0x80;
  }
  buf = Buffer.concat([buf, Buffer.from('{"type":"user","uuid":"partial","message":{"role":"us')]);
  writeFileSync(path, buf);
}

/** Queued twins `gap` bytes apart (unique texts), `pairs` of them. */
export function farTwinRows(pairs: number, gap: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < pairs; i++) {
    rows.push(user(`p${i}`, `prompt ${i}`));
    rows.push(asst(`a ${i}`));
    rows.push(att(`q${i}`, `far queued ${i}`));
    const n = 40;
    for (let k = 0; k < n; k++) rows.push(toolRes(Math.ceil(gap / n)));
    rows.push(user(`qt${i}`, `far queued ${i}`, { promptSource: "queued" }));
    rows.push(asst(`b ${i}`));
  }
  return rows;
}
