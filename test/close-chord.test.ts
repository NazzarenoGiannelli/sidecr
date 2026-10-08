import { describe, expect, test } from "bun:test";
import { isCloseChord, type ChordEvent } from "../ui/close-chord";

const ev = (code: string, mods: Partial<ChordEvent> = {}, key = ""): ChordEvent => ({
  code, key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
});

describe("isCloseChord", () => {
  test("Alt+S closes", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true }, "s"))).toBe(true);
  });
  test("Alt+S with Caps Lock (an uppercase key) still closes: the physical key decides", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true }, "S"))).toBe(true);
  });
  test("Alt+S on a layout where Alt+S types another character still closes by code", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true }, "ß"))).toBe(true);
  });
  test("Ctrl+Shift+J closes, and so does Cmd+Shift+J", () => {
    expect(isCloseChord(ev("KeyJ", { ctrlKey: true, shiftKey: true }, "J"))).toBe(true);
    expect(isCloseChord(ev("KeyJ", { metaKey: true, shiftKey: true }, "J"))).toBe(true);
  });
  test("a plain S, Shift+S and Ctrl+S do not", () => {
    expect(isCloseChord(ev("KeyS", {}, "s"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { shiftKey: true }, "S"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { ctrlKey: true }, "s"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { metaKey: true }, "s"))).toBe(false);
  });
  test("Alt+Shift+S and Ctrl+Alt+S do not", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true, shiftKey: true }, "S"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { altKey: true, ctrlKey: true }, "s"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { altKey: true, metaKey: true }, "s"))).toBe(false);
  });
  test("an AltGr press (reported as ctrl and alt together) never closes", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true, ctrlKey: true }, "ſ"))).toBe(false);
    expect(isCloseChord(ev("KeyJ", { altKey: true, ctrlKey: true, shiftKey: true }, "J"))).toBe(false);
  });
  test("Alt with another key, or Ctrl+Shift with another key, does not", () => {
    expect(isCloseChord(ev("KeyA", { altKey: true }, "a"))).toBe(false);
    expect(isCloseChord(ev("KeyK", { ctrlKey: true, shiftKey: true }, "K"))).toBe(false);
  });
  test("Ctrl+J without Shift does not", () => {
    expect(isCloseChord(ev("KeyJ", { ctrlKey: true }, "j"))).toBe(false);
  });
  test("nothing closes while an input method is composing", () => {
    expect(isCloseChord(ev("KeyS", { altKey: true, isComposing: true }, "s"))).toBe(false);
    expect(isCloseChord(ev("KeyJ", { ctrlKey: true, shiftKey: true, isComposing: true }, "J"))).toBe(false);
    expect(isCloseChord(ev("KeyS", { altKey: true, isComposing: false }, "s"))).toBe(true);
  });
  test("a bare modifier press does not", () => {
    expect(isCloseChord(ev("AltLeft", { altKey: true }, "Alt"))).toBe(false);
  });
});
