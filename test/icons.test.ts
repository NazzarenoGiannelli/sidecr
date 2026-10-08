import { describe, expect, test } from "bun:test";
import { ICONS } from "../ui/icons";

describe("icons", () => {
  test("the icon set is exactly the glyphs the UI uses", () => {
    expect(Object.keys(ICONS).sort()).toEqual([
      "arrow-down",
      "arrow-line-up",
      "arrow-square-out",
      "caret-right",
      "check",
      "circle-notch",
      "copy",
      "corners-in",
      "corners-out",
      "folder",
      "gear",
      "images",
      "minus",
      "paperclip",
      "push-pin",
      "push-pin-fill",
      "search",
      "send",
      "stop",
      "x",
    ]);
  });
  test("every icon has at least one non-empty path that starts with M", () => {
    for (const [name, paths] of Object.entries(ICONS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(typeof d, name).toBe("string");
        expect(d.length, name).toBeGreaterThan(0);
        expect(d.startsWith("M"), name).toBe(true);
      }
    }
  });
  test("path data is made of path commands and numbers only", () => {
    for (const [name, paths] of Object.entries(ICONS)) {
      for (const d of paths) expect(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/.test(d), name).toBe(true);
    }
  });
});
