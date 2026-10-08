/** Regression tests for the wave 4C review: the twin check across chunks (I1), page parses (I2), M5, M6. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory, type Page, type TranscriptReader } from "../src/transcript/history";
import { parseTranscript, type Exchange } from "../src/transcript/parse";
import { fsTranscriptReader } from "../src/transcript/reader";
import { adversarialRows, farTwinRows, writeAdversarial } from "./adversarial";
import { synthRows, toJsonl } from "./synthetic";

const dir = mkdtempSync(join(tmpdir(), "sidecr-histfix-"));
let n = 0;
const file = (content: string) => {
  const p = join(dir, `t${++n}.jsonl`);
  writeFileSync(p, content);
  return p;
};

/** What parseTranscript gives for the same bytes the index sees (complete rows only). */
function fullOfFile(path: string): Exchange[] {
  const buf = readFileSync(path);
  const end = buf.lastIndexOf(10) + 1;
  return parseTranscript(buf.subarray(0, end).toString("utf8").split(/\r?\n/).filter((l) => l.length > 0), Number.MAX_SAFE_INTEGER);
}

async function walk(h: ReturnType<typeof createHistory>, f: string, tailN: number, blockN: number) {
  const pages: Page[] = [];
  let page = (await h.tail(f, tailN))!;
  pages.push(page);
  let all = page.exchanges;
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

function recorded() {
  const log: ({ read: number } | "yield")[] = [];
  const reader: TranscriptReader = {
    size: (f) => fsTranscriptReader.size(f),
    read: (f, s, e) => {
      log.push({ read: e - s });
      return fsTranscriptReader.read(f, s, e);
    },
  };
  return { log, reader, yieldNow: async () => void log.push("yield") };
}

const worstBetweenYields = (log: ({ read: number } | "yield")[]): number => {
  let since = 0;
  let worst = 0;
  for (const x of log) {
    if (x === "yield") since = 0;
    else worst = Math.max(worst, (since += x.read));
  }
  return worst;
};

describe("the queued-twin check across chunk boundaries (I1)", () => {
  test("twins 3 MB apart: no duplicate or re-labelled queued messages, default and small chunks", async () => {
    const f = file(toJsonl(farTwinRows(8, 3 * 1024 * 1024)));
    const full = fullOfFile(f);
    expect(full.length).toBe(16);
    for (const cfg of [{}, { chunkBytes: 256 * 1024, firstTailBytes: 64 * 1024 }]) {
      const { all } = await walk(createHistory({ reader: fsTranscriptReader, ...cfg }), f, 2, 3);
      expect(all).toEqual(full);
      expect(all.filter((e) => e.id.startsWith("qt"))).toHaveLength(0);
    }
  }, 60_000);

  for (const gap of [100, 20_000]) {
    for (const crlf of [false, true]) {
      test(`every tricky row shape, the same queued text repeated, gap ${gap}, ${crlf ? "CRLF" : "LF"}`, async () => {
        const f = file("");
        writeAdversarial(f, adversarialRows(400, gap, { huge: gap === 100 }), crlf);
        const full = fullOfFile(f);
        for (const cfg of [{}, { chunkBytes: 8192, firstTailBytes: 4096 }, { chunkBytes: 65536 }]) {
          const { all } = await walk(createHistory({ reader: fsTranscriptReader, ...cfg }), f, 5, 10);
          expect(all.length).toBe(full.length);
          expect(all).toEqual(full);
        }
      }, 120_000);
    }
  }

  test("the tail alone equals parseTranscript when the twins straddle its window", async () => {
    const rows = farTwinRows(6, 200 * 1024);
    const f = file(toJsonl(rows));
    for (const k of [1, 2, 5]) expect((await createHistory({ reader: fsTranscriptReader }).tail(f, k))!.exchanges).toEqual(parseTranscript(rows, k));
  });
});

describe("page parses (I2)", () => {
  /** A session whose last turn is `steps` tool calls with `size`-byte results. */
  function bigLastTurn(steps: number, size: number): { f: string; step: () => string } {
    let k = 0;
    const res = "r".repeat(size);
    const step = () =>
      `${JSON.stringify({ type: "assistant", message: { id: `m${k}`, role: "assistant", content: [{ type: "tool_use", id: `t${k}`, name: "Bash", input: { command: `step ${k}` } }] } })}\n` +
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${k++}`, content: res }] } })}\n`;
    let body = "";
    for (let i = 0; i < 4; i++) {
      body += `${JSON.stringify({ type: "user", uuid: `p${i}`, message: { role: "user", content: `prompt ${i}` } })}\n`;
      body += `${JSON.stringify({ type: "assistant", message: { id: `a${i}`, role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } })}\n`;
    }
    body += `${JSON.stringify({ type: "user", uuid: "last", message: { role: "user", content: "go" } })}\n`;
    for (let i = 0; i < steps; i++) body += step();
    return { f: file(body), step };
  }

  test("a refresh reads only what was appended, and the growing last exchange equals the full parse", async () => {
    const { f, step } = bigLastTurn(400, 20_000); // about 8 MB in the last turn
    const rec = recorded();
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: 256 * 1024 });
    await h.tail(f, 3);
    for (let r = 0; r < 5; r++) {
      let added = "";
      for (let i = 0; i < 10; i++) added += step();
      appendFileSync(f, added);
      rec.log.length = 0;
      const p = (await h.tail(f, 3))!;
      const read = rec.log.reduce((c, x) => c + (x === "yield" ? 0 : x.read), 0);
      expect(read).toBeLessThan(Buffer.byteLength(added) * 3 + 4096); // the head check and the new rows (scan, parse)
      expect(p.exchanges).toEqual(fullOfFile(f).slice(-3));
    }
    // A new prompt closes the last exchange: it is finished from where it was, and still equals the full parse.
    appendFileSync(f, `${JSON.stringify({ type: "user", uuid: "next", message: { role: "user", content: "next" } })}\n`);
    expect((await h.tail(f, 3))!.exchanges).toEqual(fullOfFile(f).slice(-3));
  });

  test("closed exchanges come from the cache: an older block asked for again reads nothing to parse", async () => {
    const f = file(toJsonl(synthRows(3000, { seed: 61 })));
    const rec = recorded();
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow });
    const tail = (await h.tail(f, 3))!;
    const a = (await h.before(f, tail.oldestId!, 10)) as Page;
    rec.log.length = 0;
    const b = (await h.before(f, tail.oldestId!, 10)) as Page;
    expect(b).toEqual(a);
    const read = rec.log.reduce((c, x) => c + (x === "yield" ? 0 : x.read), 0);
    expect(read).toBeLessThanOrEqual(256); // only the head check
  });

  test("the cache is bounded; an exchange bigger than its budget is still returned, just not kept", async () => {
    const lines = synthRows(4000, { seed: 62, filler: 2000 });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, cacheEntries: 30, cacheBytes: 64 * 1024 });
    const { all } = await walk(h, f, 5, 20);
    expect(all).toEqual(parseTranscript(lines, Number.MAX_SAFE_INTEGER));
    const st = h.stats(f) as { cached: number; cachedCost: number };
    expect(st.cached).toBeLessThanOrEqual(30);
    expect(st.cachedCost).toBeLessThanOrEqual(64 * 1024);
    const tiny = createHistory({ reader: fsTranscriptReader, cacheBytes: 10 });
    expect((await tiny.tail(f, 5))!.exchanges).toEqual(parseTranscript(lines, 5));
    expect((tiny.stats(f) as { cached: number }).cached).toBe(0);
  });

  test("a big page is parsed a chunk at a time, with yields between", async () => {
    const { f } = bigLastTurn(300, 30_000); // about 9 MB
    const rec = recorded();
    const chunk = 128 * 1024;
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: chunk });
    await h.tail(f, 3);
    expect(worstBetweenYields(rec.log)).toBeLessThanOrEqual(2 * chunk + 256);
  });

  test("a row longer than a chunk is read whole once, with yields while its end is searched for (M7)", async () => {
    const big = `${JSON.stringify({ type: "user", uuid: "p0", message: { role: "user", content: "go" } })}\n${JSON.stringify({ type: "assistant", message: { id: "a", role: "assistant", content: [{ type: "text", text: "H".repeat(3 * 1024 * 1024) }] } })}\n`;
    const f = file(big);
    const rec = recorded();
    const chunk = 64 * 1024;
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: chunk });
    const p = (await h.tail(f, 1))!;
    expect(p.exchanges).toEqual(fullOfFile(f));
    const reads = rec.log.filter((x) => x !== "yield") as { read: number }[];
    // Nothing between a chunk and the whole row: no doubling re-reads.
    for (const r of reads) expect(r.read <= chunk || r.read >= 3 * 1024 * 1024).toBe(true);
  });
});

describe("small fixes", () => {
  test("a file first seen under 256 bytes: its replacement is still noticed (M6)", async () => {
    const f = file(`${JSON.stringify({ type: "user", uuid: "a1", message: { role: "user", content: "hi" } })}\n`);
    const h = createHistory({ reader: fsTranscriptReader });
    const a = (await h.tail(f, 5))!;
    appendFileSync(f, toJsonl(synthRows(50, { seed: 63 })));
    const b = (await h.tail(f, 5))!;
    expect(b.epoch).toBe(a.epoch); // it grew: the same file
    writeFileSync(f, toJsonl(synthRows(80, { seed: 64 }).map((r) => r.replace(/"u-/g, '"z-'))));
    expect((await h.tail(f, 5))!.epoch).not.toBe(a.epoch);
  });

  test("past maxExchanges the last page says truncated, not the beginning (M5)", async () => {
    const f = file(toJsonl(synthRows(1500, { seed: 65 })));
    const { pages } = await walk(createHistory({ reader: fsTranscriptReader, maxExchanges: 50 }), f, 5, 20);
    expect(pages.at(-1)!.hasMore).toBe(false);
    expect(pages.at(-1)!.truncated).toBe(true);
    const w = await walk(createHistory({ reader: fsTranscriptReader }), file(toJsonl(synthRows(100, { seed: 66 }))), 5, 50);
    expect(w.pages.at(-1)!.truncated).toBeUndefined();
  });
});

describe("warm-up read cost (review 2, m1)", () => {
  /** Tool output that quotes `promptSource: "queued"` in `density` of the rows; no real queued rows. */
  function quoting(prompts: number, density: number): string {
    let rnd = 7;
    const r = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
    const out: string[] = [];
    for (let i = 0; i < prompts; i++) {
      out.push(JSON.stringify({ type: "user", uuid: `p${i}`, message: { role: "user", content: `prompt ${i}` } }));
      for (let k = 0; k < 25; k++) {
        out.push(JSON.stringify({ type: "assistant", message: { id: `m${i}-${k}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}-${k}`, name: "Read", input: { file_path: `f${k}.ts` } }] } }));
        const text = (r() < density ? 'const x = { promptSource: "queued", type: "queued_command" };\n' : "") + "x".repeat(4000);
        out.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}-${k}`, content: text }] } }));
      }
    }
    return toJsonl(out);
  }

  test("rows that merely quote the queued keys never double the warm-up: a full walk reads about the file once", async () => {
    const content = quoting(120, 0.1); // about 12 MB
    const f = file(content);
    const rec = recorded();
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: 256 * 1024 });
    const { all } = await walk(h, f, 5, 50);
    expect(all).toEqual(fullOfFile(f));
    const read = rec.log.reduce((c, x) => c + (x === "yield" ? 0 : x.read), 0);
    expect(read / Buffer.byteLength(content)).toBeLessThan(2.5);
  }, 60_000);

  test("with real queued rows the walk still reads each byte only a few times", async () => {
    const f = file("");
    writeAdversarial(f, adversarialRows(400, 20_000), false);
    const rec = recorded();
    const h = createHistory({ reader: rec.reader, yieldNow: rec.yieldNow, chunkBytes: 64 * 1024 });
    const { all } = await walk(h, f, 5, 50);
    expect(all).toEqual(fullOfFile(f));
    const read = rec.log.reduce((c, x) => c + (x === "yield" ? 0 : x.read), 0);
    expect(read / readFileSync(f).length).toBeLessThan(4);
  }, 60_000);
});

describe("a read error during the last exchange's parse (review 2, m3)", () => {
  test("the next request does not add the same assistant blocks twice", async () => {
    let k = 0;
    const step = () =>
      `${JSON.stringify({ type: "assistant", message: { id: `m${k}`, role: "assistant", content: [{ type: "text", text: `step ${k} ${"t".repeat(3000)}` }] } })}\n` +
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${k++}`, content: "r".repeat(20_000) }] } })}\n`;
    let body = `${JSON.stringify({ type: "user", uuid: "p0", message: { role: "user", content: "go" } })}\n`;
    for (let i = 0; i < 20; i++) body += step();
    const f = file(body);
    // The second read of a byte range already read in the same request (the parse pass after the scan) throws, once.
    let armed = false;
    let seen = new Set<number>();
    let repeats = 0;
    const reader: TranscriptReader = {
      size: (p) => fsTranscriptReader.size(p),
      read: (p, s, e) => {
        if (armed) {
          if (seen.has(s) && ++repeats === 2) {
            armed = false;
            throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
          }
          seen.add(s);
        }
        return fsTranscriptReader.read(p, s, e);
      },
    };
    const h = createHistory({ reader, chunkBytes: 32 * 1024 });
    await h.tail(f, 1);
    let added = "";
    for (let i = 0; i < 20; i++) added += step();
    appendFileSync(f, added);
    armed = true;
    seen = new Set();
    repeats = 0;
    await expect(h.tail(f, 1)).rejects.toThrow("EBUSY");
    expect(armed).toBe(false); // it did throw in the parse pass
    const p = (await h.tail(f, 1))!;
    expect(p.exchanges).toEqual(fullOfFile(f));
  });
});

describe("a queued exchange whose turn start is not indexed yet (review 2, m2)", () => {
  test("exchange(id) of the first indexed exchange does not cache it, and the walk still equals the full parse", async () => {
    let t = Date.UTC(2026, 0, 1);
    const ts = () => new Date((t += 60_000)).toISOString();
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(JSON.stringify({ type: "user", uuid: `p${i}`, timestamp: ts(), message: { role: "user", content: `prompt ${i}` } }));
      rows.push(JSON.stringify({ type: "assistant", timestamp: ts(), message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: "x".repeat(500) }] } }));
      rows.push(JSON.stringify({ type: "attachment", uuid: `q${i}`, timestamp: ts(), attachment: { type: "queued_command", commandMode: "prompt", prompt: `queued ${i}` } }));
      rows.push(JSON.stringify({ type: "assistant", timestamp: ts(), message: { id: `n${i}`, role: "assistant", content: [{ type: "text", text: "y".repeat(500) }] } }));
    }
    const text = toJsonl(rows);
    const f = file(text);
    const full = parseTranscript(rows, Number.MAX_SAFE_INTEGER);
    // The tail window starts exactly at q30, so q30 is the first indexed exchange and its turn (p30) is not indexed.
    const off = Buffer.byteLength(toJsonl(rows.slice(0, 4 * 30 + 2)));
    const h = createHistory({ reader: fsTranscriptReader, firstTailBytes: Buffer.byteLength(text) - off + 1, warmupRows: 0 });
    await h.exchange(f, "q30");
    expect((h.stats(f) as { cached: number }).cached).toBe(0);
    const { all } = await walk(h, f, 2, 10);
    expect(all).toEqual(full);
  });
});

describe("queued twins exactly 49, 50 and 51 rows apart, the later record first in a chunk (review 2, m5)", () => {
  // Rows of one exact length, so chunk starts fall on known rows: the tail window starts T rows from the end, and each
  // backward step C rows earlier (C rows of L bytes is the chunk; 200 warm-up rows fit in it, so no long-row step).
  const L = 400;
  const T = 100;
  const C = 256;
  const pad = (o: Record<string, unknown>): string => {
    const base = JSON.stringify({ ...o, pad: "" });
    if (base.length > L) throw new Error("row too long");
    return JSON.stringify({ ...o, pad: "x".repeat(L - base.length) });
  };
  let n = 0;
  const filler = (i: number) => (i % 10 === 0 ? pad({ type: "user", uuid: `p${i}`, message: { role: "user", content: `prompt ${i}` } }) : pad({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `a ${i}` }] } }));
  const att = (text: string) => pad({ type: "attachment", uuid: `q${++n}`, attachment: { type: "queued_command", commandMode: "prompt", prompt: text } });
  const twin = (text: string) => pad({ type: "user", uuid: `qt${++n}`, promptSource: "queued", message: { role: "user", content: text } });

  function rows(): string[] {
    const total = T + 7 * C;
    const out = Array.from({ length: total }, (_, i) => filler(i));
    // Chunk starts (row indexes): total - T, then C rows earlier each time.
    const starts = Array.from({ length: 6 }, (_, j) => total - T - j * C);
    const cases: [number, "att-first" | "user-first"][] = [[49, "att-first"], [50, "att-first"], [51, "att-first"], [49, "user-first"], [50, "user-first"], [51, "user-first"]];
    cases.forEach(([d, order], j) => {
      const b = starts[j]!; // the later record sits exactly at a chunk start; the earlier one d rows before it
      const text = `twin ${d} ${order}`;
      out[b - d] = order === "att-first" ? att(text) : twin(text);
      out[b] = order === "att-first" ? twin(text) : att(text);
    });
    return out;
  }

  test("pages put together equal parseTranscript", async () => {
    const r = rows();
    for (const x of r) expect(Buffer.byteLength(x)).toBe(L);
    const f = file(toJsonl(r));
    const full = parseTranscript(r, Number.MAX_SAFE_INTEGER);
    // 51 rows apart is too far for the twin check: both records show. 49 and 50: one each.
    expect(full.filter((e) => e.user.some((b) => b.kind === "text" && b.text.startsWith("twin 51"))).length).toBe(4);
    expect(full.filter((e) => e.user.some((b) => b.kind === "text" && /^twin (49|50)/.test(b.text))).length).toBe(4);
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: C * (L + 1), firstTailBytes: T * (L + 1) });
    const { all } = await walk(h, f, 3, 10);
    expect(all).toEqual(full);
  });
});
