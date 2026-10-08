import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory, eachLine, lineStartAtOrAfter, type Page, type TranscriptReader } from "../src/transcript/history";
import { fsTranscriptReader } from "../src/transcript/reader";
import { parseTranscript, type Exchange } from "../src/transcript/parse";
import { synthRows, toJsonl } from "./synthetic";

const dir = mkdtempSync(join(tmpdir(), "sidecr-hist-"));
let fileNo = 0;
function file(content: string): string {
  const p = join(dir, `t${++fileNo}.jsonl`);
  writeFileSync(p, content);
  return p;
}

/** A reader over the real file that records what was read, and a yield that counts. */
function recorded() {
  const log: ({ read: number } | "yield")[] = [];
  const reader: TranscriptReader = {
    size: (f) => fsTranscriptReader.size(f),
    read: (f, s, e) => {
      log.push({ read: e - s });
      return fsTranscriptReader.read(f, s, e);
    },
  };
  const yieldNow = async () => {
    log.push("yield");
  };
  return { log, reader, yieldNow };
}

/** Every exchange of the file through the index: the tail, then older blocks until the beginning. */
async function walk(h: ReturnType<typeof createHistory>, f: string, tailN: number, blockN: number): Promise<{ all: Exchange[]; pages: Page[] }> {
  const pages: Page[] = [];
  const first = (await h.tail(f, tailN))!;
  pages.push(first);
  let all = first.exchanges;
  let page = first;
  while (page.hasMore) {
    const next = await h.before(f, page.oldestId!, blockN);
    if (next === null || next === "unknown") throw new Error(`walk stopped: ${next}`);
    pages.push(next);
    all = next.exchanges.concat(all);
    if (next.exchanges.length === 0) break;
    page = next;
  }
  return { all, pages };
}

const full = (rows: string[]) => parseTranscript(rows, Number.MAX_SAFE_INTEGER);

describe("eachLine / lineStartAtOrAfter", () => {
  test("lines without their breaks, CRLF too, empty lines skipped", () => {
    const buf = Buffer.from("a\r\n\nbc\nd");
    const got: string[] = [];
    eachLine(buf, 0, buf.length, (s, e) => got.push(buf.toString("utf8", s, e)));
    expect(got).toEqual(["a", "bc", "d"]);
  });
  test("line starts", () => {
    const buf = Buffer.from("ab\ncd\n");
    expect(lineStartAtOrAfter(buf, 0, true)).toBe(0);
    expect(lineStartAtOrAfter(buf, 0, false)).toBe(3);
    expect(lineStartAtOrAfter(buf, 3, false)).toBe(3);
    expect(lineStartAtOrAfter(buf, 4, false)).toBe(6);
  });
});

describe("the index pages concatenated equal the full parse", () => {
  for (const rows of [5, 500, 50_000]) {
    test(`${rows} rows`, async () => {
      const lines = synthRows(rows, { seed: rows });
      const f = file(toJsonl(lines));
      // Small chunks so a 500-row file already takes many backward steps.
      const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 8 * 1024, warmupRows: 200, firstTailBytes: 4 * 1024 });
      const { all, pages } = await walk(h, f, 5, 10);
      expect(all).toEqual(full(lines));
      expect(pages.at(-1)!.hasMore).toBe(false);
      // Every block but the last (which may be shorter) holds 10 real prompts.
      for (const p of pages.slice(1, -1)) expect(p.exchanges.filter((e) => !e.queued).length).toBe(10);
      // Ids are unique: the window keys its DOM by them.
      expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    }, 30_000);
  }

  test("the tail alone equals the parse's last n turns", async () => {
    const lines = synthRows(2000, { seed: 7 });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 16 * 1024 });
    for (const n of [1, 3, 5, 10]) expect((await h.tail(f, n))!.exchanges).toEqual(parseTranscript(lines, n));
  });

  test("default chunk sizes give the same result", async () => {
    const lines = synthRows(5000, { seed: 3 });
    const f = file(toJsonl(lines));
    const { all } = await walk(createHistory({ reader: fsTranscriptReader }), f, 5, 20);
    expect(all).toEqual(full(lines));
  });

  test("rows without a uuid get ids from their byte offset, stable across calls", async () => {
    const lines = synthRows(300, { seed: 9, noUuid: true });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 4096 });
    const a = await walk(h, f, 5, 10);
    const b = await walk(createHistory({ reader: fsTranscriptReader }), f, 5, 10);
    expect(a.all.map((e) => e.id)).toEqual(b.all.map((e) => e.id));
    const prompt = a.all.find((e) => !e.queued)!;
    expect(prompt.id).toMatch(/^@\d+$/);
    // Apart from the ids, the same as the full parse.
    expect(a.all.map(({ id: _id, ...rest }) => rest)).toEqual(full(lines).map(({ id: _id, ...rest }) => rest));
  });
});

describe("append-aware scanning", () => {
  test("appended rows show up, only the new bytes are scanned, ids stay the same", async () => {
    const lines = synthRows(3000, { seed: 11 });
    const f = file(toJsonl(lines));
    const rec = recorded();
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow });
    const before = (await h.tail(f, 5))!;
    const again = (await h.tail(f, 5))!;
    expect(again.exchanges.map((e) => e.id)).toEqual(before.exchanges.map((e) => e.id));
    expect(again.epoch).toBe(before.epoch);
    const more = synthRows(40, { seed: 12 }).map((r) => r.replace(/"u-(\d+)"/g, '"v-$1"').replace(/"q-(\d+)"/g, '"w-$1"'));
    appendFileSync(f, toJsonl(more));
    rec.log.length = 0;
    const after = (await h.tail(f, 5))!;
    expect(after.epoch).toBe(before.epoch);
    expect(after.exchanges).toEqual(parseTranscript([...lines, ...more], 5));
    // What was read: the head check, the appended bytes, and the tail page; never the whole file again.
    const read = rec.log.reduce((n, x) => n + (x === "yield" ? 0 : x.read), 0);
    const appended = Buffer.byteLength(toJsonl(more));
    const pageBytes = Buffer.byteLength(toJsonl(lines)) - 0; // upper bound, not reached
    expect(read).toBeLessThan(appended * 3 + 256 + 200_000);
    expect(read).toBeLessThan(pageBytes);
    // The older blocks still line up with the full parse.
    const walked = await walk(h, f, 5, 10);
    expect(walked.all).toEqual(full([...lines, ...more]));
  });

  test("a row still being written is not shown until its line ends", async () => {
    const f = file(toJsonl(synthRows(50, { seed: 2 })));
    const h = createHistory({ reader: fsTranscriptReader });
    const n0 = (await h.tail(f, 50))!.exchanges.length;
    const row = JSON.stringify({ type: "user", uuid: "late", message: { role: "user", content: "late prompt" } });
    appendFileSync(f, row.slice(0, 20));
    expect((await h.tail(f, 50))!.exchanges.length).toBe(n0);
    appendFileSync(f, `${row.slice(20)}\n`);
    const p = (await h.tail(f, 50))!;
    expect(p.exchanges.at(-1)!.id).toBe("late");
  });

  test("a file that shrinks is indexed again under a new epoch", async () => {
    const f = file(toJsonl(synthRows(400, { seed: 5 })));
    const h = createHistory({ reader: fsTranscriptReader });
    const a = (await h.tail(f, 5))!;
    const shorter = synthRows(100, { seed: 5 });
    writeFileSync(f, toJsonl(shorter));
    const b = (await h.tail(f, 5))!;
    expect(b.epoch).not.toBe(a.epoch);
    expect(b.exchanges).toEqual(parseTranscript(shorter, 5));
    // An id of the old epoch that is gone is unknown now.
    expect(await h.before(f, a.exchanges.at(-1)!.id, 5)).toBe("unknown");
  });

  test("a replaced file (other start, larger) is indexed again", async () => {
    const f = file(toJsonl(synthRows(200, { seed: 21 })));
    const h = createHistory({ reader: fsTranscriptReader });
    const a = (await h.tail(f, 3))!;
    const other = synthRows(600, { seed: 22 }).map((r) => r.replace(/"u-/g, '"x-'));
    writeFileSync(f, toJsonl(other));
    const b = (await h.tail(f, 3))!;
    expect(b.epoch).not.toBe(a.epoch);
    expect(b.exchanges).toEqual(parseTranscript(other, 3));
  });

  test("a file that disappears answers null, and comes back fresh", async () => {
    const f = join(dir, "missing.jsonl");
    const h = createHistory({ reader: fsTranscriptReader });
    expect(await h.tail(f, 5)).toBeNull();
    writeFileSync(f, toJsonl(synthRows(30, { seed: 1 })));
    expect((await h.tail(f, 5))!.exchanges.length).toBeGreaterThan(0);
  });
});

describe("pages", () => {
  test("hasMore, oldestId and an empty block at the very beginning", async () => {
    const lines = synthRows(5, { seed: 4 });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader });
    const p = (await h.tail(f, 10))!;
    expect(p.hasMore).toBe(false);
    expect(p.oldestId).toBe(p.exchanges[0]?.id ?? null);
    const first = await h.before(f, p.exchanges[0]!.id, 10);
    expect(first).toEqual({ exchanges: [], hasMore: false, oldestId: p.exchanges[0]!.id, epoch: p.epoch });
  });

  test("an unknown id is 'unknown' (after looking through the whole file)", async () => {
    const f = file(toJsonl(synthRows(800, { seed: 6 })));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 4096 });
    await h.tail(f, 5);
    expect(await h.before(f, "no-such-id", 5)).toBe("unknown");
    expect(h.stats(f).coveredFrom).toBe(0);
  });

  test("exchange(id) finds any exchange of the file, indexing backwards as needed", async () => {
    const lines = synthRows(3000, { seed: 8 });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 8192 });
    await h.tail(f, 3);
    const want = full(lines)[5]!;
    expect(await h.exchange(f, want.id)).toEqual(want);
    expect(await h.exchange(f, "nope")).toBeNull();
  });

  test("an empty file has no exchanges and nothing more", async () => {
    const f = file("");
    const p = (await createHistory({ reader: fsTranscriptReader }).tail(f, 5))!;
    expect(p).toMatchObject({ exchanges: [], hasMore: false, oldestId: null });
  });
});

describe("bounds", () => {
  test("at most 4 sessions (least recently used goes)", async () => {
    const h = createHistory({ reader: fsTranscriptReader });
    const files = Array.from({ length: 6 }, (_, i) => file(toJsonl(synthRows(30, { seed: 100 + i }))));
    for (const f of files) await h.tail(f, 3);
    expect(h.stats().sessions).toBe(4);
    expect(h.stats(files[0]).exchanges).toBeUndefined();
    expect(h.stats(files[5]).exchanges).toBeGreaterThan(0);
  });

  test("at most maxExchanges offsets: the oldest are not offered", async () => {
    const lines = synthRows(3000, { seed: 13 });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, maxExchanges: 120, chunkBytes: 8192 });
    const { all, pages } = await walk(h, f, 5, 20);
    expect(all.length).toBe(120);
    expect(pages.at(-1)!.hasMore).toBe(false);
    expect(h.stats(f).truncated).toBe(true);
    const everything = full(lines);
    expect(all).toEqual(everything.slice(everything.length - 120));
  });

  test("between two yields the index reads at most about one chunk", async () => {
    const lines = synthRows(60_000, { seed: 14 });
    const f = file(toJsonl(lines));
    const rec = recorded();
    const chunk = 64 * 1024;
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: chunk });
    await h.tail(f, 5);
    rec.log.length = 0;
    expect(await h.before(f, "missing", 5)).toBe("unknown"); // scans the whole file backwards
    const reads = rec.log.filter((x): x is { read: number } => x !== "yield");
    expect(reads.length).toBeGreaterThan(20);
    for (const r of reads) expect(r.read).toBeLessThanOrEqual(chunk);
    // The bytes read between two yields: one chunk, plus the small reads that find where a row starts (also <= a chunk).
    let since = 0;
    let worst = 0;
    for (const x of rec.log) {
      if (x === "yield") since = 0;
      else worst = Math.max(worst, (since += x.read));
    }
    expect(worst).toBeLessThanOrEqual(2 * chunk + 256);
  }, 30_000);
});

describe("allow-list paths", () => {
  test("paths of every block handed out are remembered; blocks never handed out are not", async () => {
    const paths = ["C:\\shots\\one.png", "/home/me/two.png"];
    const lines = synthRows(4000, { seed: 15, paths });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader });
    const tail = (await h.tail(f, 3))!;
    const inTail = new Set(tail.exchanges.flatMap((e) => e.user.flatMap((b) => (b.kind === "text" ? paths.filter((p) => b.text.includes(p)) : []))));
    for (const p of paths) expect(h.paths(f).has(p)).toBe(inTail.has(p));
    const { all } = await walk(h, f, 3, 50);
    const everywhere = new Set(all.flatMap((e) => e.user.flatMap((b) => (b.kind === "text" ? paths.filter((p) => b.text.includes(p)) : []))));
    for (const p of everywhere) expect(h.paths(f).has(p)).toBe(true);
  });
});
