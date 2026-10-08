import { describe, expect, test } from "bun:test";
import { boundsEqual, needsRecovery, readWindowBounds, recoveredPosition } from "../ui/bounds";

describe("off-screen recovery", () => {
  const area = { x: 0, y: 0, w: 1920, h: 1040 };
  const win = (x: number, y: number, w = 520, h = 760) => ({ x, y, w, h });

  test("a fully visible window needs no recovery", () => {
    expect(needsRecovery(win(100, 100), area)).toBe(false);
  });
  test("a window visible by more than 80 px each way needs none", () => {
    expect(needsRecovery(win(1920 - 200, 100), area)).toBe(false); // 200 px in
    expect(needsRecovery(win(-400, 100), area)).toBe(false); // 120 px in
    expect(needsRecovery(win(100, 1040 - 200), area)).toBe(false);
    expect(needsRecovery(win(100, -600), area)).toBe(false); // 160 px in
  });
  test("a window nearly off to the right, left, above or below is recovered", () => {
    expect(needsRecovery(win(3226, 159), area)).toBe(true); // monitor unplugged
    expect(needsRecovery(win(1920 - 40, 100), area)).toBe(true);
    expect(needsRecovery(win(-500, 100), area)).toBe(true); // 20 px in
    expect(needsRecovery(win(100, -740), area)).toBe(true);
    expect(needsRecovery(win(100, 1040 - 30), area)).toBe(true);
  });
  test("exactly 80 px visible is enough, 79 is not", () => {
    expect(needsRecovery(win(1920 - 80, 100), area)).toBe(false);
    expect(needsRecovery(win(1920 - 79, 100), area)).toBe(true);
    expect(needsRecovery(win(-440, 100), area)).toBe(false); // x + w = 80
    expect(needsRecovery(win(-441, 100), area)).toBe(true);
    expect(needsRecovery(win(100, 1040 - 80), area)).toBe(false);
    expect(needsRecovery(win(100, 1040 - 79), area)).toBe(true);
    expect(needsRecovery(win(100, -680), area)).toBe(false); // y + h = 80
    expect(needsRecovery(win(100, -681), area)).toBe(true);
  });
  test("works with an area that does not start at 0,0 (taskbar on top or a second monitor)", () => {
    const second = { x: -1920, y: 40, w: 1920, h: 1000 };
    expect(needsRecovery(win(-1500, 100), second)).toBe(false);
    expect(needsRecovery(win(100, 100), second)).toBe(true);
  });
  test("recovery moves the window 40 px inside the area, keeping its size", () => {
    expect(recoveredPosition(win(3226, 159), area)).toEqual({ x: 40, y: 40, w: 520, h: 760 });
    expect(recoveredPosition(win(3226, 159), { x: -1920, y: 40, w: 1920, h: 1000 })).toEqual({ x: -1880, y: 80, w: 520, h: 760 });
  });
  test("a window larger than the area is resized to fit", () => {
    expect(recoveredPosition(win(5000, 0, 2500, 1500), area)).toEqual({ x: 0, y: 0, w: 1920, h: 1040 });
  });
  test("a window that would stick out after the 40 px offset is pulled back in", () => {
    expect(recoveredPosition(win(5000, 0, 1900, 700), area)).toEqual({ x: 20, y: 40, w: 1900, h: 700 });
  });
});

describe("readWindowBounds", () => {
  test("maps the window geometry to x, y, w, h", () => {
    expect(readWindowBounds({ screenX: 3226, screenY: 159, outerWidth: 520, outerHeight: 760 })).toEqual({ x: 3226, y: 159, w: 520, h: 760 });
  });
  test("keeps negative positions", () => {
    expect(readWindowBounds({ screenX: -1920, screenY: -20, outerWidth: 400, outerHeight: 500 })).toEqual({ x: -1920, y: -20, w: 400, h: 500 });
  });
});

describe("boundsEqual", () => {
  const b = { x: 1, y: 2, w: 520, h: 760 };
  test("null is never equal", () => {
    expect(boundsEqual(null, b)).toBe(false);
  });
  test("same values are equal", () => {
    expect(boundsEqual({ ...b }, b)).toBe(true);
  });
  test("any differing field is not equal", () => {
    expect(boundsEqual({ ...b, x: 0 }, b)).toBe(false);
    expect(boundsEqual({ ...b, y: 0 }, b)).toBe(false);
    expect(boundsEqual({ ...b, w: 1 }, b)).toBe(false);
    expect(boundsEqual({ ...b, h: 1 }, b)).toBe(false);
  });
});
