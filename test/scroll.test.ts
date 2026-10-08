import { describe, expect, test } from "bun:test";
import { SCROLL_BUTTON_DISTANCE, distanceFromBottom, isNearBottom, shouldShowScrollButton } from "../ui/scroll";

describe("distanceFromBottom", () => {
  test("zero when scrolled to the end", () => {
    expect(distanceFromBottom(600, 400, 1000)).toBe(0);
  });
  test("the gap left below the visible part", () => {
    expect(distanceFromBottom(0, 400, 1000)).toBe(600);
    expect(distanceFromBottom(500, 400, 1000)).toBe(100);
  });
  test("content shorter than the viewport has no distance", () => {
    expect(distanceFromBottom(0, 400, 300)).toBeLessThanOrEqual(0);
  });
});

describe("isNearBottom", () => {
  test("strictly closer than the threshold", () => {
    expect(isNearBottom(521, 400, 1000, 80)).toBe(true);
    expect(isNearBottom(520, 400, 1000, 80)).toBe(false);
    expect(isNearBottom(600, 400, 1000, 80)).toBe(true);
  });
  test("matches the old inline check, scrollHeight - scrollTop - clientHeight < 80", () => {
    for (const [top, h, total] of [[0, 400, 1000], [519, 400, 1000], [520, 400, 1000], [599.5, 400, 1000], [0, 400, 300]]) {
      expect(isNearBottom(top, h, total, 80)).toBe(total - top - h < 80);
    }
  });
});

describe("shouldShowScrollButton", () => {
  test("the threshold is 160 px", () => {
    expect(SCROLL_BUTTON_DISTANCE).toBe(160);
  });
  test("shown only when more than 160 px from the bottom", () => {
    expect(shouldShowScrollButton(0, 400, 1000)).toBe(true); // 600 px away
    expect(shouldShowScrollButton(439, 400, 1000)).toBe(true); // 161 px away
    expect(shouldShowScrollButton(440, 400, 1000)).toBe(false); // exactly 160 px
    expect(shouldShowScrollButton(600, 400, 1000)).toBe(false);
  });
  test("never shown when everything fits", () => {
    expect(shouldShowScrollButton(0, 400, 300)).toBe(false);
  });
});
