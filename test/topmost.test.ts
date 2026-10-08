import { describe, expect, test } from "bun:test";
import { topmostNotice, topmostToggle } from "../ui/topmost";

describe("always on top from the keyboard", () => {
  test("the toggle flips the setting and says the new state", () => {
    expect(topmostToggle({ alwaysOnTop: true })).toEqual({ value: false, notice: "Always on top: off" });
    expect(topmostToggle({ alwaysOnTop: false })).toEqual({ value: true, notice: "Always on top: on" });
  });
  test("the notice text", () => {
    expect(topmostNotice(true)).toBe("Always on top: on");
    expect(topmostNotice(false)).toBe("Always on top: off");
  });
});
