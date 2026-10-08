import { describe, expect, test } from "bun:test";
import { BYE_IGNORE_MS, OPENING_MS, WINDOW_TTL_MS, createWindowRegistry, isWindowId } from "../src/windows";

describe("isWindowId", () => {
  test("accepts letters, digits and dashes up to 64 characters", () => {
    expect(isWindowId("a")).toBe(true);
    expect(isWindowId("3f2b9c1e-5d4a-4e8b-9a3c-0123456789ab")).toBe(true);
    expect(isWindowId("A-z-0-9")).toBe(true);
    expect(isWindowId("x".repeat(64))).toBe(true);
  });
  test("rejects empty, too long, other characters and non-strings", () => {
    expect(isWindowId("")).toBe(false);
    expect(isWindowId("x".repeat(65))).toBe(false);
    expect(isWindowId("a b")).toBe(false);
    expect(isWindowId("a_b")).toBe(false);
    expect(isWindowId("a/b")).toBe(false);
    expect(isWindowId("a\nb")).toBe(false);
    expect(isWindowId("é")).toBe(false);
    expect(isWindowId(42)).toBe(false);
    expect(isWindowId(null)).toBe(false);
    expect(isWindowId(undefined)).toBe(false);
  });
});

describe("window registry", () => {
  test("hello registers a window", () => {
    const r = createWindowRegistry();
    r.hello("a", 1000);
    expect(r.alive(1000)).toEqual(["a"]);
  });

  test("hello reports the other alive windows, not itself", () => {
    const r = createWindowRegistry();
    expect(r.hello("a", 1000)).toEqual([]);
    expect(r.hello("b", 2000)).toEqual(["a"]);
    expect(r.hello("b", 3000)).toEqual(["a"]); // a repeat hello of the same window changes nothing
    expect(r.hello("c", 4000).sort()).toEqual(["a", "b"]);
  });

  test("hello does not report a window that expired", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    expect(r.hello("b", WINDOW_TTL_MS + 1)).toEqual([]);
  });

  test("ping refreshes a window", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.ping("a", 8000);
    expect(r.alive(8000 + WINDOW_TTL_MS - 1)).toEqual(["a"]);
    expect(r.alive(8000 + WINDOW_TTL_MS)).toEqual([]);
  });

  test("a ping from an unknown id registers it", () => {
    const r = createWindowRegistry();
    r.ping("late", 500);
    expect(r.alive(500)).toEqual(["late"]);
  });

  test("keepAlive refreshes a known window but never registers an unknown one or revives one that said bye", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.keepAlive("a", 8000);
    expect(r.alive(8000 + WINDOW_TTL_MS - 1)).toEqual(["a"]);
    r.keepAlive("stranger", 8000);
    r.bye("a", 8000);
    r.keepAlive("a", 9000);
    expect(r.alive(9000)).toEqual([]);
  });

  test("a window expires 9000 ms after it was last seen", () => {
    expect(WINDOW_TTL_MS).toBe(9000);
    const r = createWindowRegistry();
    r.hello("a", 1000);
    expect(r.alive(1000 + 8999)).toEqual(["a"]);
    expect(r.alive(1000 + 9000)).toEqual([]);
  });

  test("bye removes a window at once", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.hello("b", 0);
    r.bye("a", 0);
    expect(r.alive(1)).toEqual(["b"]);
    r.bye("never-seen", 0); // not an error
    expect(r.alive(1)).toEqual(["b"]);
  });

  test("expired windows are dropped from memory, not just hidden", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    expect(r.alive(WINDOW_TTL_MS)).toEqual([]);
    expect(r.size()).toBe(0);
  });
});

describe("toggle", () => {
  test("with no window it opens, then closes, then opens again", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    r.hello("a", 1000); // the window it asked for comes up
    expect(r.toggle(2000)).toEqual({ action: "close", ids: ["a"] });
    r.bye("a", 2000); // and goes away
    expect(r.toggle(3000)).toEqual({ action: "open" });
  });

  test("close names every alive window", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.hello("b", 0);
    const t = r.toggle(10);
    expect(t.action).toBe("close");
    if (t.action === "close") expect(t.ids.sort()).toEqual(["a", "b"]);
  });

  test("a window past its time to live does not count: toggle opens", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    expect(r.toggle(WINDOW_TTL_MS)).toEqual({ action: "open" });
  });

  test("a second press while the first window is still starting closes (the opening marker)", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    expect(r.toggle(OPENING_MS - 1)).toEqual({ action: "close", ids: [] });
  });

  test("the marker is used up by the close that follows it", () => {
    const r = createWindowRegistry();
    r.toggle(0);
    expect(r.toggle(1000)).toEqual({ action: "close", ids: [] });
    expect(r.toggle(2000)).toEqual({ action: "open" });
  });

  test("the marker expires after 6000 ms", () => {
    expect(OPENING_MS).toBe(6000);
    const r = createWindowRegistry();
    r.toggle(0);
    expect(r.toggle(OPENING_MS)).toEqual({ action: "open" });
  });

  test("markOpening sets the marker on its own", () => {
    const r = createWindowRegistry();
    r.markOpening(100);
    expect(r.toggle(100 + OPENING_MS - 1)).toEqual({ action: "close", ids: [] });
  });

  test("a close with windows alive also clears a fresh marker", () => {
    const r = createWindowRegistry();
    r.markOpening(0);
    r.hello("a", 10);
    expect(r.toggle(20)).toEqual({ action: "close", ids: ["a"] });
    r.bye("a", 20);
    expect(r.toggle(30)).toEqual({ action: "open" });
  });
});

describe("the opening marker and hello / bye", () => {
  test("toggle (open), hello, bye, toggle opens again: the arrived window consumed the marker", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    r.hello("a", 1000);
    r.bye("a", 2000);
    expect(r.toggle(3000)).toEqual({ action: "open" });
  });

  test("toggle (open), toggle before any hello still closes", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    expect(r.toggle(1000)).toEqual({ action: "close", ids: [] });
  });

  test("bye clears a fresh marker when no window remains, not while another is alive", () => {
    const r = createWindowRegistry();
    r.markOpening(0);
    r.hello("a", 10); // clears the marker
    r.markOpening(20); // a second open is on its way
    r.bye("a", 30);
    expect(r.toggle(40)).toEqual({ action: "open" }); // nothing remains: the marker went with the last window
    const s = createWindowRegistry();
    s.hello("a", 0);
    s.hello("b", 0);
    s.markOpening(10);
    s.bye("a", 20);
    expect(s.toggle(30)).toEqual({ action: "close", ids: ["b"] });
  });

  test("a hello that is ignored (tombstoned) does not clear the marker", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.bye("a", 10);
    r.markOpening(20);
    r.hello("a", 30); // a late hello of the window that just left
    expect(r.toggle(40)).toEqual({ action: "close", ids: [] });
  });
});

describe("close requests that reach a window without a stream", () => {
  test("toggle close flags every alive window; takeClose delivers once and clears", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.hello("b", 0);
    r.toggle(10);
    expect(r.takeClose("a")).toBe(true);
    expect(r.takeClose("a")).toBe(false); // cleared after delivery
    expect(r.takeClose("b")).toBe(true);
  });

  test("a window that registered after the toggle is not affected", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.toggle(10);
    r.hello("late", 20); // note: hello reports "a" as an other window, the server closes it by push
    r.ping("later", 30);
    expect(r.takeClose("late")).toBe(false);
    expect(r.takeClose("later")).toBe(false);
    expect(r.takeClose("a")).toBe(true);
  });

  test("hello flags the other alive windows too, so an older window without a stream is closed by its next ping", () => {
    const r = createWindowRegistry();
    r.hello("a", 0); // no stream
    expect(r.hello("b", 10)).toEqual(["a"]);
    expect(r.takeClose("a")).toBe(true);
    expect(r.takeClose("a")).toBe(false);
    expect(r.takeClose("b")).toBe(false);
  });

  test("a repeated hello of the only window flags nothing", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.hello("a", 10);
    expect(r.takeClose("a")).toBe(false);
  });

  test("an open answer sets no flag", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.bye("a", 1);
    r.toggle(2); // open
    r.hello("b", 3);
    expect(r.takeClose("b")).toBe(false);
  });

  test("a window that said bye loses its flag", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.toggle(1);
    r.bye("a", 2);
    expect(r.takeClose("a")).toBe(false);
  });

  test("an unknown id has no flag", () => {
    expect(createWindowRegistry().takeClose("nobody")).toBe(false);
  });
});

describe("tombstones after bye", () => {
  test("ping and hello for an id that just said bye are ignored for 5 s", () => {
    expect(BYE_IGNORE_MS).toBe(5000);
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.bye("a", 1000);
    r.ping("a", 1500); // a ping that was in flight during pagehide
    expect(r.alive(1500)).toEqual([]);
    expect(r.hello("a", 2000)).toEqual([]);
    expect(r.alive(2000)).toEqual([]);
  });

  test("after 5 s the id registers again", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.bye("a", 1000);
    r.ping("a", 1000 + BYE_IGNORE_MS - 1);
    expect(r.alive(1000 + BYE_IGNORE_MS - 1)).toEqual([]);
    r.ping("a", 1000 + BYE_IGNORE_MS);
    expect(r.alive(1000 + BYE_IGNORE_MS)).toEqual(["a"]);
  });

  test("another id is not affected, and old tombstones are pruned", () => {
    const r = createWindowRegistry();
    r.bye("a", 0);
    r.ping("b", 1);
    expect(r.alive(1)).toEqual(["b"]);
    r.ping("c", 100_000);
    expect(r.tombstones()).toBe(0);
  });
});

describe("a second press while the window is still launching", () => {
  test("open, second press before hello: the window that arrives is told to close", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    expect(r.toggle(2000)).toEqual({ action: "close", ids: [] });
    expect(r.hello("a", 3000)).toEqual([]);
    expect(r.takeClose("a")).toBe(true); // the answer to its hello says close
    expect(r.takeClose("a")).toBe(false);
  });

  test("the flag is used up by that window: the next window is not affected", () => {
    const r = createWindowRegistry();
    r.toggle(0);
    r.toggle(1000);
    r.hello("a", 2000);
    r.takeClose("a");
    r.bye("a", 2100);
    r.hello("b", 9000);
    expect(r.takeClose("b")).toBe(false);
  });

  test("the flag expires with the opening marker: a window arriving after 6 s stays", () => {
    const r = createWindowRegistry();
    r.toggle(0);
    r.toggle(1000); // close with no ids
    r.hello("late", OPENING_MS); // 6000 ms after the open
    expect(r.takeClose("late")).toBe(false);
  });

  test("it does not survive a later press that opens again", () => {
    const r = createWindowRegistry();
    r.toggle(0);
    r.toggle(1000); // flag set
    expect(r.toggle(2000)).toEqual({ action: "open" }); // nothing alive, marker gone: a new launch
    r.hello("a", 3000);
    expect(r.takeClose("a")).toBe(false);
  });

  test("a normal sequence is unchanged: open, hello, close", () => {
    const r = createWindowRegistry();
    expect(r.toggle(0)).toEqual({ action: "open" });
    expect(r.hello("a", 1000)).toEqual([]);
    expect(r.takeClose("a")).toBe(false);
    expect(r.toggle(2000)).toEqual({ action: "close", ids: ["a"] });
    expect(r.takeClose("a")).toBe(true);
  });

  test("a close with a window alive does not arm the flag", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.markOpening(10);
    expect(r.toggle(20)).toEqual({ action: "close", ids: ["a"] });
    r.bye("a", 30);
    r.hello("b", 40);
    expect(r.takeClose("b")).toBe(false);
  });

  test("a hello that is ignored (just said bye) does not consume the flag", () => {
    const r = createWindowRegistry();
    r.hello("a", 0);
    r.bye("a", 10);
    r.toggle(20); // open
    r.toggle(30); // close with no ids: flag armed
    r.hello("a", 40); // a late hello of the window that just left
    r.hello("b", 50);
    expect(r.takeClose("b")).toBe(true);
  });
});
