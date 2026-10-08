import { describe, expect, test } from "bun:test";
import { createMediaList, indexingNote, jumpScrollTop, JUMP_CAP, MORE_PX, planJump, tabFromKey, type MediaResponse } from "../ui/media-state";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe("tabs", () => {
  test("Left/Right and 1/2 pick a tab; modifiers do not", () => {
    expect(tabFromKey(k("ArrowRight"), "images")).toBe("links");
    expect(tabFromKey(k("ArrowLeft"), "links")).toBe("images");
    expect(tabFromKey(k("ArrowLeft"), "images")).toBeNull();
    expect(tabFromKey(k("1"), "links")).toBe("images");
    expect(tabFromKey(k("2"), "images")).toBe("links");
    expect(tabFromKey(k("2", { ctrlKey: true }), "images")).toBeNull();
    expect(tabFromKey(k("x"), "images")).toBeNull();
  });
  test("the indexing note", () => {
    expect(indexingNote(null)).toBe("");
    expect(indexingNote({ progress: 0.426, complete: false })).toBe("Indexing… 42%");
    expect(indexingNote({ progress: 1, complete: false })).toBe("Indexing… 99%");
    expect(indexingNote({ progress: 1, complete: true })).toBe("");
  });
});

type Item = { id: string };
function list(pages: ((cursor: string | null) => MediaResponse<Item> | Error)[]) {
  const calls: (string | null)[] = [];
  let changes = 0;
  let i = 0;
  const l = createMediaList<Item>({
    fetch: async (cursor) => {
      calls.push(cursor);
      const r = pages[Math.min(i++, pages.length - 1)]!(cursor);
      if (r instanceof Error) throw r;
      return r;
    },
    keyOf: (x) => x.id,
    changed: () => changes++,
  });
  return { l, calls, changes: () => changes };
}
const page = (ids: string[], next: string | null, complete = true, progress = 1): MediaResponse<Item> => ({ items: ids.map((id) => ({ id })), next, complete, progress, total: 0 });

describe("the paged list", () => {
  test("pages follow the cursor; the end is the end", async () => {
    const { l, calls } = list([() => page(["a", "b"], "c1"), () => page(["c"], null)]);
    expect(l.status()).toBe("idle");
    await l.load();
    expect(l.status()).toBe("ready");
    expect(l.wantsMore(MORE_PX - 1)).toBe(true);
    expect(l.wantsMore(MORE_PX + 1)).toBe(false);
    await l.load();
    expect(calls).toEqual([null, "c1"]);
    expect(l.items().map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(await l.load()).toBe("end");
    expect(l.wantsMore(0)).toBe(false);
  });

  test("one load at a time, duplicates dropped", async () => {
    const { l } = list([() => page(["a", "b"], "c1", false, 0.2), () => page(["b", "c"], "c2", false, 0.5)]);
    const p = l.load();
    expect(await l.load()).toBe("skipped");
    await p;
    await l.load();
    expect(l.items().map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(l.growing()).toBe(true);
  });

  test("an empty page while the index grows keeps the cursor and asks again", async () => {
    const { l, calls } = list([() => page(["a"], "c1", false, 0.3), () => page([], null, false, 0.6), () => page(["z"], null, true)]);
    await l.load();
    await l.load();
    expect(l.wantsMore(0)).toBe(true);
    await l.load();
    expect(calls).toEqual([null, "c1", "c1"]);
    expect(l.items().map((x) => x.id)).toEqual(["a", "z"]);
    expect(l.growing()).toBe(false);
  });

  test("empty and error states; a retry after an error", async () => {
    const e = list([() => page([], null, true)]);
    await e.l.load();
    expect(e.l.status()).toBe("empty");
    const f = list([() => Object.assign(new Error("boom"), { status: 502 }), () => page(["a"], null)]);
    expect(await f.l.load()).toBe("failed");
    expect(f.l.status()).toBe("error");
    expect(f.l.error()).toBe("boom");
    expect(f.l.wantsMore(0)).toBe(false);
    await f.l.load();
    expect(f.l.status()).toBe("ready");
  });

  test("a stale cursor (410) starts again from the top, once", async () => {
    const { l, calls } = list([() => page(["a"], "c1"), () => Object.assign(new Error("stale"), { status: 410 }), () => page(["x"], null)]);
    await l.load();
    await l.load();
    expect(calls).toEqual([null, "c1", null]);
    expect(l.items().map((x) => x.id)).toEqual(["x"]);
  });

  test("peek updates only the progress", async () => {
    const { l } = list([() => page(["a"], "c1", false, 0.1), () => page(["new"], "zz", false, 0.7)]);
    await l.load();
    await l.peek();
    expect(l.last()!.progress).toBe(0.7);
    expect(l.items().map((x) => x.id)).toEqual(["a"]);
  });

  test("a reset drops an answer in flight", async () => {
    let release!: (r: MediaResponse<Item>) => void;
    const l = createMediaList<Item>({ fetch: () => new Promise((r) => { release = r; }), keyOf: (x) => x.id, changed: () => {} });
    const p = l.load();
    l.reset();
    release(page(["a"], null));
    expect(await p).toBe("dropped");
    expect(l.items()).toHaveLength(0);
  });
});

describe("go to message", () => {
  test("the plan: found, wait for a load in flight, load, the cap, or not loadable", () => {
    expect(planJump({ found: true, loaded: 0, hasMore: true, loading: true })).toBe("found");
    expect(planJump({ found: false, loaded: 0, hasMore: true, loading: true })).toBe("wait");
    expect(planJump({ found: false, loaded: 120, hasMore: true, loading: false })).toBe("load");
    expect(planJump({ found: false, loaded: JUMP_CAP, hasMore: true, loading: false })).toBe("cap");
    expect(planJump({ found: false, loaded: 10, hasMore: false, loading: false })).toBe("missing");
  });
  test("the exchange lands a third of the way down the view", () => {
    // View from 50 to 650 (600 px): the target at 1250 in the viewport goes to 50 + 200.
    expect(jumpScrollTop(1000, 1250, 50, 600)).toBe(2000);
    expect(jumpScrollTop(0, 100, 50, 600)).toBe(0);
  });
});

describe("go to message never hangs (review C1, M10)", () => {
  const { createOlderLoader } = require("../ui/history") as typeof import("../ui/history");
  const { runJump, MAX_JUMP_STEPS, pollDelay, POLL_MAX_MS } = require("../ui/media-state") as typeof import("../ui/media-state");

  function failingLoader() {
    let fail = true;
    const loader = createOlderLoader({
      fetchOlder: async () => {
        if (fail) throw Object.assign(new Error("502"), { status: 502 });
        return { exchanges: [], hasMore: false, oldestId: null, epoch: 1 };
      },
      context: () => "p", apply: () => {}, reset: () => {}, failed: () => {}, changed: () => {},
    });
    loader.fromTail({ hasMore: true, oldestId: "a", epoch: 1 }, "a");
    return { loader, heal: () => { fail = false; } };
  }

  test("an earlier failed load waiting for Retry: the jump stops at once with 'error' (the real loader)", async () => {
    const { loader } = failingLoader();
    expect(await loader.load(10)).toBe("failed");
    let loads = 0;
    let waits = 0;
    const end = await runJump({
      found: () => false, loaded: () => 0, hasMore: () => loader.hasMore(), loading: () => loader.loading(), failed: () => loader.failed(),
      load: () => { loads++; return loader.load(50); }, here: () => true, wait: async () => { waits++; },
    });
    expect(end).toBe("error");
    expect(loads + waits).toBeLessThanOrEqual(1);
  });

  test("a load that fails during the jump ends it with 'error'", async () => {
    const { loader } = failingLoader();
    const end = await runJump({
      found: () => false, loaded: () => 0, hasMore: () => loader.hasMore(), loading: () => loader.loading(), failed: () => loader.failed(),
      load: () => loader.load(50), here: () => true, wait: async () => {},
    });
    expect(end).toBe("error");
  });

  test("a tail reset during the jump (another epoch) ends it with 'changed'; a pane switch with 'left'", async () => {
    const base = { found: () => false, loaded: () => 0, hasMore: () => true, loading: () => false, failed: () => false, wait: async () => {} };
    expect(await runJump({ ...base, load: async () => "reset", here: () => true })).toBe("changed");
    expect(await runJump({ ...base, load: async () => "dropped", here: () => true })).toBe("changed");
    let here = true;
    expect(await runJump({ ...base, load: async () => { here = false; return "dropped"; }, here: () => here })).toBe("left");
  });

  test("whatever the loader says, the jump is bounded (a loader that always skips, one that is always loading)", async () => {
    let steps = 0;
    const base = { found: () => false, loaded: () => 0, hasMore: () => true, failed: () => false, here: () => true };
    const skipping = await runJump({ ...base, loading: () => false, load: async () => { steps++; return "skipped"; }, wait: async () => { steps++; } });
    expect(skipping).toBe("stuck");
    expect(steps).toBeLessThanOrEqual(2 * MAX_JUMP_STEPS);
    let waits = 0;
    const busy = await runJump({ ...base, loading: () => true, load: async () => "loaded", wait: async () => { waits++; } });
    expect(busy).toBe("stuck");
    expect(waits).toBe(MAX_JUMP_STEPS);
  });

  test("the planner itself stops on a failed load and after MAX_JUMP_STEPS", () => {
    expect(planJump({ found: false, loaded: 0, hasMore: true, loading: false, failed: true })).toBe("error");
    expect(planJump({ found: false, loaded: 0, hasMore: true, loading: false, steps: MAX_JUMP_STEPS })).toBe("stuck");
    expect(planJump({ found: true, loaded: 0, hasMore: true, loading: false, failed: true })).toBe("found");
  });

  test("polling backs off after failures (review M3)", () => {
    expect(pollDelay(0)).toBe(800);
    expect(pollDelay(1)).toBe(1600);
    expect(pollDelay(3)).toBe(6400);
    expect(pollDelay(10)).toBe(POLL_MAX_MS);
  });

  test("a failed peek says so (the panel schedules again instead of stopping)", async () => {
    let fail = false;
    const l = createMediaList<{ id: string }>({
      fetch: async () => { if (fail) throw new Error("x"); return { items: [{ id: "a" }], next: "c", complete: false, progress: 0.1, total: 1 }; },
      keyOf: (x) => x.id, changed: () => {},
    });
    await l.load();
    fail = true;
    expect(await l.peek()).toBe("failed");
    fail = false;
    expect(await l.peek()).toBe("ok");
  });
});
