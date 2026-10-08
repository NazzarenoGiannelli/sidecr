import { describe, expect, test } from "bun:test";
import { createByeSender } from "../ui/window-bye";

function setup(throwing = false) {
  let sent = 0;
  const b = createByeSender({ send: () => { sent++; if (throwing) throw new Error("beacon refused"); } });
  return { b, count: () => sent };
}

describe("bye sender", () => {
  test("beforeunload then pagehide (a normal page unload) says bye once", () => {
    const { b, count } = setup();
    b.sendOnce(); // beforeunload
    b.sendOnce(); // pagehide
    expect(count()).toBe(1);
  });

  test("pagehide alone says bye once", () => {
    const { b, count } = setup();
    b.sendOnce();
    expect(count()).toBe(1);
  });

  test("beforeunload alone (an app window closed by window.close() never fires pagehide) says bye once", () => {
    const { b, count } = setup();
    b.sendOnce();
    expect(count()).toBe(1);
  });

  test("nothing is sent until an unload event calls it (a minimised window, visibilitychange, stays registered)", () => {
    const { count } = setup();
    expect(count()).toBe(0);
  });

  test("a page restored from the back/forward cache can say bye again after rearm", () => {
    const { b, count } = setup();
    b.sendOnce();
    b.sendOnce();
    expect(count()).toBe(1);
    b.rearm(); // pageshow with persisted
    b.sendOnce();
    expect(count()).toBe(2);
  });

  test("rearm without a bye sent changes nothing", () => {
    const { b, count } = setup();
    b.rearm();
    b.sendOnce();
    b.sendOnce();
    expect(count()).toBe(1);
  });

  test("a beacon that throws does not throw out of the listener, and is not retried by the other event", () => {
    const { b, count } = setup(true);
    expect(() => b.sendOnce()).not.toThrow();
    expect(() => b.sendOnce()).not.toThrow();
    expect(count()).toBe(1);
  });
});
