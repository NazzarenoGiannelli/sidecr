import { describe, expect, test } from "bun:test";
import { createDebouncer } from "../ui/debounce";
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
    count: () => pending.size,
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

describe("createDebouncer", () => {
  test("runs once, after the delay, with the latest arguments", () => {
    const f = fakeTimers();
    const seen: string[][] = [];
    const d = createDebouncer((a: string, b: string) => seen.push([a, b]), 400, f.timers);
    d.call("w1", "a");
    f.advance(399);
    expect(seen).toEqual([]);
    f.advance(1);
    expect(seen).toEqual([["w1", "a"]]);
  });
  test("every call restarts the wait", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => seen.push(t), 400, f.timers);
    d.call("a");
    f.advance(300);
    d.call("ab");
    f.advance(300);
    expect(seen).toEqual([]);
    f.advance(100);
    expect(seen).toEqual(["ab"]);
  });
  test("flush runs the pending call right away, once", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => seen.push(t), 400, f.timers);
    d.call("a");
    d.call("ab");
    d.flush();
    expect(seen).toEqual(["ab"]);
    expect(f.count()).toBe(0);
    f.advance(1000);
    expect(seen).toEqual(["ab"]);
  });
  test("flush with nothing pending does nothing", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => seen.push(t), 400, f.timers);
    d.flush();
    d.call("a");
    f.advance(400);
    d.flush();
    expect(seen).toEqual(["a"]);
  });
  test("cancel drops the pending call", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => seen.push(t), 400, f.timers);
    d.call("a");
    d.cancel();
    f.advance(1000);
    d.flush();
    expect(seen).toEqual([]);
    expect(f.count()).toBe(0);
  });
  test("it can be used again after it ran", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => seen.push(t), 400, f.timers);
    d.call("a");
    f.advance(400);
    d.call("b");
    f.advance(400);
    expect(seen).toEqual(["a", "b"]);
  });
  test("a call made from inside the callback is kept for its own delay", () => {
    const f = fakeTimers();
    const seen: string[] = [];
    const d = createDebouncer((t: string) => {
      seen.push(t);
      if (t === "a") d.call("again");
    }, 400, f.timers);
    d.call("a");
    f.advance(400);
    expect(seen).toEqual(["a"]);
    f.advance(400);
    expect(seen).toEqual(["a", "again"]);
  });
});
