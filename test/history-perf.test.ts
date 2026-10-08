import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory } from "../src/transcript/history";
import { fsTranscriptReader } from "../src/transcript/reader";
import { synthRows } from "./synthetic";
import { budget } from "./timing";

const dir = mkdtempSync(join(tmpdir(), "sidecr-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a 100 MB transcript: the tail in under 300 ms, the first older block in under 300 ms after it", async () => {
  const f = join(dir, "big.jsonl");
  const fd = openSync(f, "w");
  let seed = 1;
  while (statSync(f).size < 100 * 1024 * 1024) {
    // Distinct ids per batch, so ids stay unique across the repeated batches.
    const batch = synthRows(20_000, { seed: seed++, filler: 400 }).map((r) => r.replace(/"(u|q|qt|int|side|meta)-(\d+)"/g, `"$1-${seed}-$2"`));
    writeSync(fd, `${batch.join("\n")}\n`);
  }
  closeSync(fd);
  const size = statSync(f).size;
  const h = createHistory({ reader: fsTranscriptReader });
  const t0 = performance.now();
  const tail = (await h.tail(f, 5))!;
  const t1 = performance.now();
  const older = await h.before(f, tail.oldestId!, 10);
  const t2 = performance.now();
  if (older === null || older === "unknown") throw new Error("no older block");
  console.log(`perf: ${(size / 1048576).toFixed(1)} MB, tail ${(t1 - t0).toFixed(1)} ms (${tail.exchanges.length} exchanges), older block ${(t2 - t1).toFixed(1)} ms (${older.exchanges.length} exchanges)`);
  expect(tail.exchanges.length).toBeGreaterThanOrEqual(5);
  expect(older.exchanges.filter((e) => !e.queued).length).toBe(10);
  expect(t1 - t0).toBeLessThan(budget(300));
  expect(t2 - t1).toBeLessThan(budget(300));
}, 120_000);
