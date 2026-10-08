import { describe, expect, test } from "bun:test";
import type { Exchange } from "../src/transcript/parse";
import { anchoredScrollTop, blockSig, createOlderLoader, NEAR_TOP_PX, pickAnchor, planTail, type OlderPage, type TopState } from "../ui/history";

const ex = (id: string, extra: Partial<Exchange> = {}): Exchange => ({ id, user: [{ kind: "text", text: id }], assistant: [], ...extra });

describe("keyed tail diff", () => {
  test("an empty window: nothing to reset or remove, the tail is simply rendered", () => {
    expect(planTail([], ["a", "b"], false)).toEqual({ reset: false, remove: [] });
  });
  test("overlap: history before the tail stays, nothing is rebuilt", () => {
    expect(planTail(["h1", "h2", "a", "b"], ["a", "b", "c"], true)).toEqual({ reset: false, remove: [] });
  });
  test("a tail exchange that disappeared is removed; history before the tail's first id is not", () => {
    expect(planTail(["h1", "a", "x", "b"], ["a", "b"], true)).toEqual({ reset: false, remove: ["x"] });
  });
  test("a smaller tail (fewer exchanges shown): the older ones stay as history", () => {
    expect(planTail(["a", "b", "c", "d"], ["c", "d"], true)).toEqual({ reset: false, remove: [] });
  });
  test("no overlap (a gap could hide in between), another epoch, or an empty tail: reset", () => {
    expect(planTail(["a", "b"], ["y", "z"], true).reset).toBe(true);
    expect(planTail(["a", "b"], ["a", "b"], false).reset).toBe(true);
    expect(planTail(["a"], [], true).reset).toBe(true);
  });
  test("block signatures change with the content, an image by its data", () => {
    expect(blockSig({ kind: "text", text: "a" })).not.toBe(blockSig({ kind: "text", text: "ab" }));
    expect(blockSig({ kind: "tools", count: 1, items: [] })).not.toBe(blockSig({ kind: "tools", count: 2, items: [] }));
    expect(blockSig({ kind: "image", dataUrl: "data:image/png;base64,AAAA" })).toBe(blockSig({ kind: "image", dataUrl: "data:image/png;base64,AAAA" }));
    expect(blockSig({ kind: "image", dataUrl: "data:image/png;base64,AAAA" })).not.toBe(blockSig({ kind: "image", dataUrl: "data:image/png;base64,AAAB" }));
  });
});

describe("prepend anchoring", () => {
  test("the anchor is the first block the reader sees", () => {
    expect(pickAnchor([50, 120, 400], 100)).toBe(1);
    expect(pickAnchor([150, 300], 100)).toBe(0);
    expect(pickAnchor([10, 20], 100)).toBe(1); // all above: the last one
    expect(pickAnchor([], 100)).toBe(-1);
  });
  test("scrollTop moves by exactly how far the anchor moved", () => {
    // 600 px of older blocks went in above an anchor at 80 px from the top: it is now at 680, scroll down 600.
    expect(anchoredScrollTop(10, 80, 680)).toBe(610);
    // The browser already kept it in place.
    expect(anchoredScrollTop(610, 80, 80)).toBe(610);
    expect(anchoredScrollTop(0, 300, 100)).toBe(0); // never negative
  });
});

function harness(over: Partial<Parameters<typeof createOlderLoader>[0]> = {}) {
  const calls: string[] = [];
  const states: TopState[] = [];
  const applied: OlderPage[] = [];
  let pane = "p1";
  let resets = 0;
  const failures: string[] = [];
  let next: (before: string) => Promise<OlderPage> = async (before) => ({ exchanges: [ex(`before-${before}`)], hasMore: true, oldestId: `before-${before}`, epoch: 1 });
  const loader = createOlderLoader({
    fetchOlder: (before, n, ctx) => {
      calls.push(`${ctx}:${before}:${n}`);
      return next(before);
    },
    context: () => pane,
    apply: (p) => applied.push(p),
    reset: () => resets++,
    failed: (m) => failures.push(m),
    changed: (s) => states.push(s),
    ...over,
  });
  return {
    loader, calls, states, applied, failures,
    resets: () => resets,
    setPane: (p: string) => { pane = p; },
    setNext: (f: typeof next) => { next = f; },
  };
}

describe("older-block loader", () => {
  test("starts from the tail: the window's oldest id and the tail's hasMore", async () => {
    const h = harness();
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    expect(h.loader.state()).toBe("more");
    expect(h.loader.wants(NEAR_TOP_PX)).toBe(true);
    expect(h.loader.wants(NEAR_TOP_PX + 1)).toBe(false);
    expect(await h.loader.load(10)).toBe("loaded");
    expect(h.calls).toEqual(["p1:t1:10"]);
    expect(h.loader.oldestId()).toBe("before-t1");
    // The next one continues from the new oldest.
    await h.loader.load(10);
    expect(h.calls[1]).toBe("p1:before-t1:10");
  });

  test("no double loads: a second call while one is in flight is skipped", async () => {
    const h = harness();
    let release!: () => void;
    h.setNext((before) => new Promise((r) => { release = () => r({ exchanges: [ex(`o-${before}`)], hasMore: true, oldestId: `o-${before}`, epoch: 1 }); }));
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    const first = h.loader.load(10);
    expect(h.loader.state()).toBe("loading");
    expect(h.loader.wants(0)).toBe(false);
    expect(await h.loader.load(10)).toBe("skipped");
    release();
    expect(await first).toBe("loaded");
    expect(h.calls).toHaveLength(1);
  });

  test("a pane switch while loading drops the answer", async () => {
    const h = harness();
    let release!: () => void;
    h.setNext(() => new Promise((r) => { release = () => r({ exchanges: [ex("old")], hasMore: true, oldestId: "old", epoch: 1 }); }));
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    const p = h.loader.load(10);
    h.setPane("p2");
    h.loader.reset();
    release();
    expect(await p).toBe("dropped");
    expect(h.applied).toHaveLength(0);
    expect(h.loader.state()).toBe("hidden");
  });

  test("an error shows once and waits for a retry (scrolling does not retry by itself)", async () => {
    const h = harness();
    h.setNext(async () => { throw Object.assign(new Error("herdr down"), { status: 502, code: "herdr" }); });
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    expect(await h.loader.load(10)).toBe("failed");
    expect(h.failures).toEqual(["herdr down"]);
    expect(h.loader.state()).toBe("error");
    expect(h.loader.wants(0)).toBe(false);
    expect(await h.loader.load(10)).toBe("skipped");
    h.setNext(async () => ({ exchanges: [ex("o")], hasMore: false, oldestId: "o", epoch: 1 }));
    expect(await h.loader.load(10, { retry: true })).toBe("loaded");
    expect(h.loader.state()).toBe("start");
  });

  test("the beginning: an empty block or hasMore false ends the loading", async () => {
    const h = harness();
    h.setNext(async () => ({ exchanges: [], hasMore: false, oldestId: "t1", epoch: 1 }));
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    await h.loader.load(10);
    expect(h.loader.state()).toBe("start");
    expect(h.loader.wants(0)).toBe(false);
  });

  test("a replaced session file goes back to the tail: unknown id (404) or another epoch", async () => {
    const h = harness();
    h.setNext(async () => { throw Object.assign(new Error("gone"), { status: 404, code: "unknown-exchange" }); });
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    expect(await h.loader.load(10)).toBe("reset");
    expect(h.resets()).toBe(1);
    expect(h.failures).toHaveLength(0);
    const g = harness();
    g.setNext(async () => ({ exchanges: [ex("o")], hasMore: true, oldestId: "o", epoch: 2 }));
    g.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    expect(await g.loader.load(10)).toBe("reset");
    expect(g.applied).toHaveLength(0);
  });

  test("a later tail does not undo the loaded history's hasMore; a new epoch does", async () => {
    const h = harness();
    h.setNext(async () => ({ exchanges: [ex("o")], hasMore: false, oldestId: "o", epoch: 1 }));
    h.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    await h.loader.load(10);
    h.loader.fromTail({ hasMore: true, oldestId: "t5", epoch: 1 }, "o");
    expect(h.loader.state()).toBe("start");
    expect(h.loader.oldestId()).toBe("o");
    h.loader.fromTail({ hasMore: true, oldestId: "n1", epoch: 7 }, "n1");
    expect(h.loader.state()).toBe("more");
    expect(h.loader.oldestId()).toBe("n1");
  });

  test("an empty conversation hides the top row", () => {
    const h = harness();
    h.loader.fromTail({ hasMore: false, oldestId: null, epoch: null }, null);
    expect(h.loader.state()).toBe("hidden");
  });
});

describe("past the server's 20,000-exchange index (review M5)", () => {
  test("the top row says the older history is not indexed, not the beginning", async () => {
    const h = harness();
    h.loader.fromTail({ hasMore: false, oldestId: "t1", epoch: 1, truncated: true }, "t1");
    expect(h.loader.state()).toBe("truncated");
    const g = harness();
    g.setNext(async () => ({ exchanges: [ex("o")], hasMore: false, oldestId: "o", epoch: 1, truncated: true }));
    g.loader.fromTail({ hasMore: true, oldestId: "t1", epoch: 1 }, "t1");
    await g.loader.load(10);
    expect(g.loader.state()).toBe("truncated");
    expect(g.loader.failed()).toBe(false);
  });
});
