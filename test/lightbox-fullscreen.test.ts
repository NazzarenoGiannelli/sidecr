import { describe, expect, test } from "bun:test";
import { ICONS } from "../ui/icons";
import { ESC_GUARD_MS, createLightboxFullscreen, fullscreenButton, type KeyLike } from "../ui/lightbox-fullscreen";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra,
});
const open = { lightboxOpen: true, typing: false };

function setup() {
  let clock = 1000;
  const fs = createLightboxFullscreen({ now: () => clock });
  return { fs, tick: (ms: number) => { clock += ms; } };
}

describe("F toggles fullscreen", () => {
  test("f and F with the lightbox open", () => {
    const { fs } = setup();
    expect(fs.key(key("f"), open)).toBe("toggle");
    expect(fs.key(key("F"), open)).toBe("toggle"); // Caps Lock
  });
  test("not with the lightbox closed, while typing in a field, or with another modifier", () => {
    const { fs } = setup();
    expect(fs.key(key("f"), { lightboxOpen: false, typing: false })).toBe("pass");
    expect(fs.key(key("f"), { lightboxOpen: true, typing: true })).toBe("pass");
    for (const m of ["ctrlKey", "altKey", "metaKey", "shiftKey"] as const) {
      expect(fs.key(key("f", { [m]: true }), open)).toBe("pass");
    }
  });
  test("not while an input method composes, and not on auto-repeat", () => {
    const { fs } = setup();
    expect(fs.key(key("f", { isComposing: true }), open)).toBe("pass");
    expect(fs.key(key("f", { repeat: true }), open)).toBe("pass");
  });
  test("other keys pass", () => {
    const { fs } = setup();
    expect(fs.key(key("g"), open)).toBe("pass");
    expect(fs.key(key("Enter"), open)).toBe("pass");
  });
});

describe("Esc leaves fullscreen first, a second Esc closes the lightbox", () => {
  test("Esc while fullscreen only exits fullscreen", () => {
    const { fs } = setup();
    fs.changed(true);
    expect(fs.key(key("Escape"), open)).toBe("exit");
  });
  test("Esc when not fullscreen passes on to the normal layering", () => {
    const { fs } = setup();
    expect(fs.key(key("Escape"), open)).toBe("pass");
  });
  test("the Esc that the browser itself used to leave fullscreen is swallowed if it also reaches the page", () => {
    const { fs, tick } = setup();
    fs.changed(true);
    fs.changed(false); // the browser left fullscreen on Esc
    tick(ESC_GUARD_MS - 1);
    expect(fs.key(key("Escape"), open)).toBe("swallow");
  });
  test("a later Esc closes the lightbox: the guard is short", () => {
    const { fs, tick } = setup();
    fs.changed(true);
    fs.changed(false);
    tick(ESC_GUARD_MS);
    expect(fs.key(key("Escape"), open)).toBe("pass");
  });
  test("the guard applies once per exit and not to a lightbox that was never fullscreen", () => {
    const { fs, tick } = setup();
    expect(fs.key(key("Escape"), open)).toBe("pass");
    fs.changed(false); // a change event that is not an exit from fullscreen
    expect(fs.key(key("Escape"), open)).toBe("pass");
    fs.changed(true);
    fs.changed(false);
    tick(10);
    expect(fs.key(key("Escape"), open)).toBe("swallow");
    expect(fs.key(key("Escape"), open)).toBe("pass"); // used up by the keypress it belonged to
  });
  test("Esc with the lightbox closed is never ours", () => {
    const { fs } = setup();
    fs.changed(true);
    expect(fs.key(key("Escape"), { lightboxOpen: false, typing: false })).toBe("pass");
  });
});

describe("state follows the real fullscreen state", () => {
  test("fullscreen() reflects the last change", () => {
    const { fs } = setup();
    expect(fs.fullscreen()).toBe(false);
    fs.changed(true);
    expect(fs.fullscreen()).toBe(true);
    fs.changed(false);
    expect(fs.fullscreen()).toBe(false);
  });
  test("closing the lightbox asks to exit only while fullscreen", () => {
    const { fs } = setup();
    expect(fs.shouldExitOnClose()).toBe(false);
    fs.changed(true);
    expect(fs.shouldExitOnClose()).toBe(true);
  });
});

describe("the button", () => {
  test("corners-out to enter, corners-in to leave, with matching labels", () => {
    expect(fullscreenButton(false)).toEqual({ icon: "corners-out", label: "Fullscreen (F)" });
    expect(fullscreenButton(true)).toEqual({ icon: "corners-in", label: "Leave fullscreen (F)" });
  });
  test("both icons exist", () => {
    expect(ICONS["corners-out"].length).toBeGreaterThan(0);
    expect(ICONS["corners-in"].length).toBeGreaterThan(0);
  });
});
