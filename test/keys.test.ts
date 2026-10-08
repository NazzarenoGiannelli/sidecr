import { describe, expect, test } from "bun:test";
import {
  cheatSheet,
  chordMatches,
  composerKey,
  conflicts,
  KEY_GROUPS,
  keysFor,
  matchShortcut,
  SHORTCUTS,
  tooltip,
  tooltipWith,
  type KeyLike,
  type Shortcut,
} from "../ui/keys";

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
});
const main = { typing: false, lightboxOpen: false };
const typing = { typing: true, lightboxOpen: false };
const inLightbox = { typing: false, lightboxOpen: true };
const hit = (e: KeyLike, ctx = main) => matchShortcut(e, ctx)?.shortcut.id ?? null;

describe("the registry", () => {
  test("every entry has an id, keys, a label and a known group", () => {
    for (const s of SHORTCUTS) {
      expect(s.id.length, s.id).toBeGreaterThan(0);
      expect(s.keys.length, s.id).toBeGreaterThan(0);
      expect(s.label.trim().length, s.id).toBeGreaterThan(0);
      expect(KEY_GROUPS.includes(s.group), s.id).toBe(true);
    }
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });
  test("no chord is bound twice in the same context", () => {
    expect(conflicts()).toEqual([]);
  });
  test("the duplicate check sees a clash, including through 'always' and Shift 'any'", () => {
    const a: Shortcut = { id: "a", keys: ["X"], label: "a", group: "Window", handler: "close", chords: [{ key: "/", mod: true, shift: "any" }], when: "always", whileTyping: true };
    const b: Shortcut = { id: "b", keys: ["X"], label: "b", group: "Window", handler: "close", chords: [{ key: "/", mod: true, shift: true }], when: "lightbox", whileTyping: true };
    const c: Shortcut = { id: "c", keys: ["X"], label: "c", group: "Window", handler: "close", chords: [{ key: "/", mod: true }], when: "main", whileTyping: true };
    expect(conflicts([a, b])).toEqual(["lightbox|mod+shift+key:/: a, b"]);
    expect(conflicts([b, c])).toEqual([]);
    expect(conflicts([a, c]).length).toBe(1);
  });
  test("entries with chords are dispatched by the app; the rest are handled where they live", () => {
    const listedOnly = new Set(["composer", "escape", "lightbox-window", "mouse", "herdr", "media-panel"]);
    for (const s of SHORTCUTS) {
      if (listedOnly.has(s.handler)) expect(s.chords, s.id).toEqual([]);
      else expect(s.chords.length, s.id).toBeGreaterThan(0);
    }
  });
});

describe("matching", () => {
  test("Ctrl+K and Ctrl+Shift+K open the switcher, also while typing; Cmd counts as Ctrl", () => {
    expect(hit(key("k", "KeyK", { ctrlKey: true }))).toBe("switcher");
    expect(hit(key("K", "KeyK", { ctrlKey: true, shiftKey: true }), typing)).toBe("switcher");
    expect(hit(key("k", "KeyK", { metaKey: true }))).toBe("switcher");
  });
  test("Ctrl+, opens the settings; Ctrl+/ and ? open the cheat sheet, ? only outside a text field", () => {
    expect(hit(key(",", "Comma", { ctrlKey: true }), typing)).toBe("settings");
    expect(hit(key("/", "Slash", { ctrlKey: true }), typing)).toBe("cheatsheet");
    // Italian layout: / is Shift+7, still Ctrl+/ by the character.
    expect(hit(key("/", "Digit7", { ctrlKey: true, shiftKey: true }))).toBe("cheatsheet");
    // By the physical key only when the event carries no character at all (key "" or "Unidentified"), which is what
    // CDP-synthesised events carry; a real keyboard reports a key, which must then match by key.
    expect(hit(key("", "Slash", { ctrlKey: true }), typing)).toBe("cheatsheet");
    expect(hit(key("Unidentified", "Slash", { ctrlKey: true }), typing)).toBe("cheatsheet");
    expect(hit(key("", "Digit7", { ctrlKey: true, shiftKey: true }), typing)).toBe("cheatsheet");
    expect(hit(key("7", "Digit7", { ctrlKey: true }))).toBeNull();
  });
  test("Ctrl+- on the Italian/German layout (the physical Slash key) is left to the browser (zoom out)", () => {
    expect(hit(key("-", "Slash", { ctrlKey: true }))).toBeNull();
    expect(hit(key("-", "Slash", { ctrlKey: true }), typing)).toBeNull();
    expect(hit(key("_", "Slash", { ctrlKey: true, shiftKey: true }))).toBeNull();
    // US Ctrl+Shift+7 is "&", not "/".
    expect(hit(key("&", "Digit7", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
  test("the real Italian Ctrl+/ (Ctrl+Shift+7 reporting key \"/\") resolves by key, as before", () => {
    expect(hit(key("/", "Digit7", { ctrlKey: true, shiftKey: true }), typing)).toBe("cheatsheet");
    expect(hit(key("?", "Slash", { shiftKey: true }))).toBe("cheatsheet");
    expect(hit(key("?", "Minus", { shiftKey: true }))).toBe("cheatsheet");
    expect(hit(key("?", "Slash", { shiftKey: true }), typing)).toBeNull();
  });
  test("Alt+Up/Down step through panes, Alt+1..9 pick one, with the number as the argument", () => {
    expect(hit(key("ArrowUp", "ArrowUp", { altKey: true }), typing)).toBe("prev-pane");
    expect(hit(key("ArrowDown", "ArrowDown", { altKey: true }))).toBe("next-pane");
    const r = matchShortcut(key("3", "Digit3", { altKey: true }), main);
    expect(r?.shortcut.id).toBe("nth-pane");
    expect(r?.chord.arg).toBe(3);
    expect(hit(key("0", "Digit0", { altKey: true }))).toBeNull();
  });
  test("AltGr (Ctrl and Alt together) never triggers an Alt or a Ctrl shortcut", () => {
    expect(hit(key("ſ", "KeyS", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(hit(key("@", "Digit2", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(hit(key("k", "KeyK", { altKey: true, ctrlKey: true }))).toBeNull();
  });
  test("Ctrl+End scrolls and lets the caret move too; Ctrl+Shift+C copies the last answer", () => {
    const end = matchShortcut(key("End", "End", { ctrlKey: true }), typing);
    expect(end?.shortcut.id).toBe("scroll-bottom");
    expect(end?.shortcut.preventDefault).toBe(false);
    expect(hit(key("End", "End", { ctrlKey: true, shiftKey: true }), typing)).toBeNull(); // select to end stays
    expect(hit(key("C", "KeyC", { ctrlKey: true, shiftKey: true }), typing)).toBe("copy-answer");
    expect(hit(key("c", "KeyC", { ctrlKey: true }), typing)).toBeNull(); // plain copy stays
  });
  test("Alt+S and Ctrl+Shift+J close everywhere, the lightbox too", () => {
    expect(hit(key("s", "KeyS", { altKey: true }), typing)).toBe("close");
    expect(hit(key("s", "KeyS", { altKey: true }), inLightbox)).toBe("close");
    expect(hit(key("J", "KeyJ", { ctrlKey: true, shiftKey: true }))).toBe("close");
  });
  test("F toggles fullscreen only with the lightbox open and not in a text field", () => {
    expect(hit(key("f", "KeyF"), inLightbox)).toBe("lightbox-fullscreen");
    expect(hit(key("F", "KeyF"), inLightbox)).toBe("lightbox-fullscreen"); // Caps Lock
    expect(hit(key("F", "KeyF", { shiftKey: true }), inLightbox)).toBeNull(); // Shift+F is not F
    expect(hit(key("f", "KeyF"), main)).toBeNull();
    expect(hit(key("f", "KeyF"), { typing: true, lightboxOpen: true })).toBeNull();
  });
  test("with the lightbox open the main-window shortcuts are off (as Ctrl+Shift+K was)", () => {
    expect(hit(key("k", "KeyK", { ctrlKey: true }), inLightbox)).toBeNull();
    expect(hit(key(",", "Comma", { ctrlKey: true }), inLightbox)).toBeNull();
  });
  test("repeats and IME composition never trigger", () => {
    expect(hit(key("k", "KeyK", { ctrlKey: true, repeat: true }))).toBeNull();
    expect(hit(key("k", "KeyK", { ctrlKey: true, isComposing: true }))).toBeNull();
  });
  test("chordMatches: one-character keys ignore case, named keys do not", () => {
    expect(chordMatches({ key: "f" }, key("f", "KeyF"))).toBe(true);
    expect(chordMatches({ key: "f", shift: true }, key("F", "KeyF", { shiftKey: true }))).toBe(true);
    expect(chordMatches({ key: "End", mod: true }, key("end", "End", { ctrlKey: true }))).toBe(false);
  });
});

describe("cheat sheet", () => {
  const listed = (sheet: ReturnType<typeof cheatSheet>) => [...sheet.top, ...sheet.groups.flatMap((g) => g.rows)].map((r) => r.id);
  test("in the shell it lists every registry entry exactly once", () => {
    const ids = listed(cheatSheet({ inShell: true }));
    expect([...ids].sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
  });
  test("in the browser window it lists every entry except the shell-only ones", () => {
    const ids = listed(cheatSheet({ inShell: false }));
    expect([...ids].sort()).toEqual(SHORTCUTS.filter((s) => !s.shellOnly).map((s) => s.id).sort());
  });
  test("Alt+S is at the top, marked as a herdr key; groups follow in order", () => {
    const sheet = cheatSheet({ inShell: true });
    expect(sheet.top).toEqual([{ id: "herdr-toggle", keys: ["Alt+S"], label: "Open or close Sidecr", herdr: true }]);
    expect(sheet.groups.map((g) => g.group)).toEqual(["Sessions", "Messages", "Images", "Window", "Settings"]);
  });
  test("Send and New line follow the sendKey setting", () => {
    const rows = (sendKey: "enter" | "ctrl-enter") => cheatSheet({ inShell: true, settings: { sendKey } }).groups.find((g) => g.group === "Messages")!.rows;
    expect(rows("enter").find((r) => r.id === "send")!.keys).toEqual(["Enter"]);
    expect(rows("ctrl-enter").find((r) => r.id === "send")!.keys).toEqual(["Ctrl+Enter"]);
    expect(rows("ctrl-enter").find((r) => r.id === "newline")!.keys).toEqual(["Enter", "Shift+Enter"]);
  });
});

describe("tooltips come from the registry", () => {
  test("the header, composer and window buttons", () => {
    expect(tooltip("settings")).toBe("Settings (Ctrl+,)");
    expect(tooltip("switcher")).toBe("Switch session (Ctrl+K)");
    expect(tooltip("close")).toBe("Close (Alt+S)");
    expect(tooltip("cheatsheet")).toBe("Keyboard shortcuts (Ctrl+/)");
    expect(tooltip("lightbox-fullscreen")).toBe("Fullscreen (F)");
    expect(tooltip("send")).toBe("Send (Enter)");
    expect(tooltip("send", { sendKey: "ctrl-enter" })).toBe("Send (Ctrl+Enter)");
  });
  test("keysFor leaves other entries as defined", () => {
    const s = SHORTCUTS.find((x) => x.id === "switcher")!;
    expect(keysFor(s, { sendKey: "ctrl-enter" })).toEqual(s.keys);
  });
  test("an unknown id is a programming error", () => {
    expect(() => tooltip("nope")).toThrow();
  });
});

describe("composerKey (Enter / Ctrl+Enter per the sendKey setting)", () => {
  const enter = (mods: Partial<KeyLike> = {}) => key("Enter", "Enter", mods);
  test("enter: Enter sends, Shift+Enter is a new line, Ctrl+Enter also sends", () => {
    expect(composerKey(enter(), "enter")).toBe("send");
    expect(composerKey(enter({ shiftKey: true }), "enter")).toBe("newline");
    expect(composerKey(enter({ ctrlKey: true }), "enter")).toBe("send");
  });
  test("ctrl-enter: Enter is a new line, Ctrl+Enter (or Cmd+Enter) sends, Shift+Enter is a new line", () => {
    expect(composerKey(enter(), "ctrl-enter")).toBe("newline");
    expect(composerKey(enter({ ctrlKey: true }), "ctrl-enter")).toBe("send");
    expect(composerKey(enter({ metaKey: true }), "ctrl-enter")).toBe("send");
    expect(composerKey(enter({ shiftKey: true, ctrlKey: true }), "ctrl-enter")).toBe("newline");
  });
  test("other keys, Alt+Enter and IME composition pass", () => {
    expect(composerKey(key("a", "KeyA"), "enter")).toBe("pass");
    expect(composerKey(enter({ altKey: true }), "enter")).toBe("pass");
    expect(composerKey(enter({ isComposing: true }), "enter")).toBe("pass");
  });
});

describe("the Media & links shortcut", () => {
  test("Ctrl+Shift+M opens it, also while typing, not with the lightbox open; its tooltip and cheat sheet row", () => {
    const e = { key: "M", code: "KeyM", ctrlKey: true, altKey: false, metaKey: false, shiftKey: true };
    expect(matchShortcut(e, { typing: false, lightboxOpen: false })?.shortcut.id).toBe("media");
    expect(matchShortcut(e, { typing: true, lightboxOpen: false })?.shortcut.id).toBe("media");
    expect(matchShortcut(e, { typing: false, lightboxOpen: true })).toBeNull();
    expect(tooltip("media")).toBe("Media & links (Ctrl+Shift+M)");
    const rows = cheatSheet({ inShell: false }).groups.find((g) => g.group === "Images")!.rows.map((r) => r.id);
    expect(rows).toContain("media");
    expect(rows).toContain("media-tabs");
    expect(conflicts()).toEqual([]);
  });
});

describe("following herdr and always on top", () => {
  const press = (over: Partial<KeyLike>): KeyLike => ({ key: "", code: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over });
  test("Ctrl+Shift+L toggles the pin and Alt+. goes to herdr's pane, both while typing in the composer", () => {
    expect(matchShortcut(press({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true }), { typing: true, lightboxOpen: false })?.shortcut.id).toBe("follow-pin");
    expect(matchShortcut(press({ key: ".", code: "Period", altKey: true }), { typing: true, lightboxOpen: false })?.shortcut.id).toBe("follow-now");
    expect(matchShortcut(press({ key: ".", code: "Period" }), { typing: true, lightboxOpen: false })).toBeNull();
  });
  test("the pin tooltip follows the state; the key comes from the registry", () => {
    expect(tooltip("follow-pin")).toBe("Following herdr (Ctrl+Shift+L)");
    expect(tooltipWith("follow-pin", "Pinned to morning")).toBe("Pinned to morning (Ctrl+Shift+L)");
    expect(tooltipWith("follow-now", "Switch to docs · review")).toBe("Switch to docs · review (Alt+.)");
  });
  test("Ctrl+Shift+T toggles always on top, while typing too; tooltip; listed in the shell's cheat sheet only", () => {
    expect(matchShortcut(press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), { typing: true, lightboxOpen: false, inShell: true })?.shortcut.id).toBe("always-on-top");
    // In the Chromium window it is not matched at all: the key stays the browser's.
    expect(matchShortcut(press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), { typing: true, lightboxOpen: false, inShell: false })).toBeNull();
    expect(matchShortcut(press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), { typing: true, lightboxOpen: false })).toBeNull();
    expect(tooltip("always-on-top")).toBe("Always on top (Ctrl+Shift+T)");
    const ids = (inShell: boolean) => cheatSheet({ inShell }).groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids(true)).toContain("always-on-top");
    expect(ids(false)).not.toContain("always-on-top");
    const windowRows = cheatSheet({ inShell: true }).groups.find((g) => g.group === "Window")!.rows;
    expect(windowRows.find((r) => r.id === "always-on-top")!.label).toBe("Toggle always on top");
  });
  test("the follow keys are in the Sessions group of both cheat sheets", () => {
    for (const inShell of [true, false]) {
      const rows = cheatSheet({ inShell }).groups.find((g) => g.group === "Sessions")!.rows.map((r) => r.id);
      expect(rows).toContain("follow-pin");
      expect(rows).toContain("follow-now");
    }
  });
});
