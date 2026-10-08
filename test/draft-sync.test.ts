import { describe, expect, test } from "bun:test";
import { createDraftSync } from "../ui/draft-sync";
import type { TimerApi } from "../ui/timers";

function fakeTimers() {
  let next = 1;
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: TimerApi = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => void pending.delete(id as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

function setup(opts: { load?: (pane: string) => Promise<string>; save?: (pane: string, text: string, keepalive: boolean) => Promise<unknown> } = {}) {
  const f = fakeTimers();
  const saved: string[] = [];
  const sync = createDraftSync({
    load: opts.load ?? (async () => ""),
    save: opts.save ?? (async (pane, text, keepalive) => void saved.push(`${pane}|${text}|${keepalive}`)),
    timers: f.timers,
  });
  return { sync, f, saved };
}

describe("writing", () => {
  test("typing is saved 400 ms after the last keystroke", () => {
    const s = setup();
    s.sync.typed("w1:p1", "he");
    s.f.advance(300);
    s.sync.typed("w1:p1", "hel");
    s.f.advance(399);
    expect(s.saved).toEqual([]);
    s.f.advance(1);
    expect(s.saved).toEqual(["w1:p1|hel|false"]);
  });
  test("flush saves the pending text at once, with keepalive", () => {
    const s = setup();
    s.sync.typed("w1:p1", "hello");
    s.sync.flush();
    expect(s.saved).toEqual(["w1:p1|hello|true"]);
    s.f.advance(1000);
    expect(s.saved).toEqual(["w1:p1|hello|true"]);
  });
  test("a timer-driven save after a flush has no keepalive", () => {
    const s = setup();
    s.sync.typed("w1:p1", "a");
    s.sync.flush();
    s.sync.typed("w1:p1", "ab");
    s.f.advance(400);
    expect(s.saved).toEqual(["w1:p1|a|true", "w1:p1|ab|false"]);
  });
  test("flush with nothing pending saves nothing", () => {
    const s = setup();
    s.sync.flush();
    expect(s.saved).toEqual([]);
  });
  test("clear drops the pending text and writes an empty draft now", () => {
    const s = setup();
    s.sync.typed("w1:p1", "sent text");
    s.sync.clear("w1:p1");
    s.f.advance(1000);
    expect(s.saved).toEqual(["w1:p1||false"]);
  });
  test("clearing one pane leaves another pane's pending text alone", () => {
    const s = setup();
    s.sync.typed("w2:p1", "typed in the pane I switched to");
    s.sync.clear("w1:p1");
    s.f.advance(400);
    expect(s.saved).toEqual(["w1:p1||false", "w2:p1|typed in the pane I switched to|false"]);
  });
  test("a failing save is ignored", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let attempts = 0;
      const s = setup({ save: async () => { attempts++; throw new Error("offline"); } });
      s.sync.typed("w1:p1", "a");
      s.sync.flush();
      s.sync.clear("w1:p1");
      // An unhandled rejection is reported after the microtasks drain: let a macrotask pass before looking.
      await new Promise((r) => setImmediate(r));
      expect(attempts).toBe(2); // the flush and the clear both tried, so the failure really happened
      expect(s.saved).toEqual([]); // nothing was recorded as saved
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  test("a save that throws synchronously is ignored", () => {
    const s = setup({ save: () => { throw new Error("sync"); } });
    s.sync.typed("w1:p1", "a");
    expect(() => s.sync.flush()).not.toThrow();
  });
});

describe("restoring", () => {
  const empty = (pane = "w1:p1") => () => ({ pane, value: "" });
  test("an untouched empty composer gets the stored text", async () => {
    const s = setup({ load: async () => "half written" });
    expect(await s.sync.restore("w1:p1", empty())).toBe("half written");
  });
  test("nothing stored gives null", async () => {
    const s = setup({ load: async () => "" });
    expect(await s.sync.restore("w1:p1", empty())).toBeNull();
  });
  test("if the user typed while the request was in flight, the draft is not applied", async () => {
    let release!: (t: string) => void;
    const s = setup({ load: () => new Promise<string>((r) => (release = r)) });
    const p = s.sync.restore("w1:p1", empty());
    s.sync.typed("w1:p1", "x");
    release("stored");
    expect(await p).toBeNull();
  });
  test("if the composer is no longer empty, the draft is not applied", async () => {
    const s = setup({ load: async () => "stored" });
    expect(await s.sync.restore("w1:p1", () => ({ pane: "w1:p1", value: "typed elsewhere" }))).toBeNull();
  });
  test("if the pane changed meanwhile, the draft is not applied", async () => {
    const s = setup({ load: async () => "stored" });
    expect(await s.sync.restore("w1:p1", () => ({ pane: "w2:p1", value: "" }))).toBeNull();
  });
  test("a failed load gives null", async () => {
    const s = setup({ load: async () => { throw new Error("offline"); } });
    expect(await s.sync.restore("w1:p1", empty())).toBeNull();
  });
  test("typing before the restore started does not block it", async () => {
    const s = setup({ load: async () => "stored" });
    s.sync.typed("w1:p1", "x");
    expect(await s.sync.restore("w1:p1", empty())).toBe("stored");
  });
});
