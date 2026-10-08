import { describe, expect, test } from "bun:test";
import {
  accentText,
  effectOf,
  isWindows11,
  MIN_COMPOSER_ALPHA,
  MIN_PANEL_ALPHA,
  strengthToTint,
  surfaceAlphas,
  tauriEffect,
  TEXT_SCALE,
} from "../src/look";
import { ACCENTS, defaultSettings } from "../src/settings-schema";
import { isWindows11Release, shellArgs, shellStartOf } from "../src/shell";
import { cssVarsOf, createShellLook, type EffectsWindow } from "../ui/shell-look";
import { MIN_COMBINED_OPACITY, tintMatters } from "../src/look";

describe("strength mapping", () => {
  test("tint alpha: 30 at 0, the original 150 at the default 60, 230 at 100; clamped and integer", () => {
    expect(strengthToTint(0)).toBe(30);
    expect(strengthToTint(60)).toBe(150);
    expect(strengthToTint(100)).toBe(230);
    expect(strengthToTint(-5)).toBe(30);
    expect(strengthToTint(500)).toBe(230);
    expect(strengthToTint(Number.NaN)).toBe(150);
    for (let s = 0; s <= 100; s++) expect(Number.isInteger(strengthToTint(s))).toBe(true);
  });
  test("surfaces: 0.25 at 0, the original 0.55 at 60, 0.95 at 100", () => {
    expect(surfaceAlphas(0, true).surface).toBe(0.25);
    expect(surfaceAlphas(60, true)).toEqual({ surface: 0.55, composer: 0.7, panel: 0.95 });
    expect(surfaceAlphas(100, true).surface).toBe(0.95);
  });
  test("readable at every value: composer and panels never below their minimum, everything grows with strength", () => {
    let prev = surfaceAlphas(0, true);
    for (let s = 0; s <= 100; s++) {
      const a = surfaceAlphas(s, true);
      expect(a.composer).toBeGreaterThanOrEqual(MIN_COMPOSER_ALPHA);
      expect(a.panel).toBeGreaterThanOrEqual(MIN_PANEL_ALPHA);
      expect(a.composer).toBeGreaterThanOrEqual(a.surface);
      expect(a.surface).toBeGreaterThanOrEqual(prev.surface);
      expect(a.composer).toBeGreaterThanOrEqual(prev.composer);
      expect(Math.max(a.surface, a.composer, a.panel)).toBeLessThanOrEqual(1);
      prev = a;
    }
  });
  test("translucency off: everything opaque, whatever the strength", () => {
    for (const s of [0, 60, 100]) expect(surfaceAlphas(s, false)).toEqual({ surface: 1, composer: 1, panel: 1 });
  });
});

describe("accent, text size, effect", () => {
  test("accent text is the colour mixed 40 % with white; the default gives the shell's old text accent", () => {
    expect(accentText("#5347fd")).toBe("#9891fe");
    expect(accentText("#000000")).toBe("#666666");
    expect(accentText("nope")).toBe("#9a92ff");
    for (const a of ACCENTS) expect(accentText(a.value)).toMatch(/^#[0-9a-f]{6}$/);
  });
  test("text scale", () => {
    expect(TEXT_SCALE).toEqual({ small: 0.92, medium: 1, large: 1.12 });
  });
  test("effectOf: off is none; only Mica falls back to Acrylic outside Windows 11 (Blur works from Windows 10); unknown keeps the choice", () => {
    expect(effectOf({ acrylic: false, effect: "mica" }, true)).toBe("none");
    expect(effectOf({ acrylic: true, effect: "mica" }, true)).toBe("mica");
    expect(effectOf({ acrylic: true, effect: "mica" }, false)).toBe("acrylic");
    expect(effectOf({ acrylic: true, effect: "mica" }, null)).toBe("mica");
    expect(effectOf({ acrylic: true, effect: "blur" }, false)).toBe("blur");
    expect(effectOf({ acrylic: true, effect: "blur" }, null)).toBe("blur");
    expect(effectOf({ acrylic: true, effect: "acrylic" }, false)).toBe("acrylic");
  });
  test("the Tauri Effect values (the page is dark: dark Mica)", () => {
    expect(tauriEffect("acrylic")).toBe("acrylic");
    expect(tauriEffect("mica")).toBe("micaDark");
    expect(tauriEffect("blur")).toBe("blur");
  });
  test("Windows 11 detection from userAgentData and from os.release()", () => {
    expect(isWindows11("Windows", "15.0.0")).toBe(true);
    expect(isWindows11("Windows", "10.0.0")).toBe(false);
    expect(isWindows11("macOS", "14.0.0")).toBeNull();
    expect(isWindows11("Windows", undefined)).toBeNull();
    expect(isWindows11Release("win32", "10.0.26200")).toBe(true);
    expect(isWindows11Release("win32", "10.0.19045")).toBe(false);
    expect(isWindows11Release("linux", "6.1.0")).toBeNull();
    expect(isWindows11Release("win32", "10.0")).toBeNull();
  });
});

describe("the shell's start options", () => {
  test("from the settings: topmost, effect, tint", () => {
    expect(shellStartOf(defaultSettings(), true)).toEqual({ topmost: true, effect: "acrylic", tint: 150 });
    expect(shellStartOf({ ...defaultSettings(), acrylic: false, alwaysOnTop: false, strength: 0 }, true)).toEqual({ topmost: false, effect: "none", tint: 30 });
    expect(shellStartOf({ ...defaultSettings(), effect: "mica" }, false).effect).toBe("acrylic");
  });
  test("as flags after the URL and bounds; none without start options", () => {
    expect(shellArgs("http://x/", null, { topmost: false, effect: "blur", tint: 90 })).toEqual(["--url", "http://x/", "--no-topmost", "--effect", "blur", "--tint", "90"]);
    expect(shellArgs("http://x/", { x: 1, y: 2, w: 600, h: 800 }, { topmost: true, effect: "acrylic", tint: 150 })).toEqual([
      "--url", "http://x/", "--x", "1", "--y", "2", "--w", "600", "--h", "800", "--effect", "acrylic", "--tint", "150",
    ]);
    expect(shellArgs("http://x/", null, null)).toEqual(["--url", "http://x/"]);
  });
});

describe("cssVarsOf", () => {
  test("the browser window gets only the text scale", () => {
    expect(cssVarsOf({ ...defaultSettings(), textSize: "large" }, false)).toEqual({ "--text-scale": "1.12" });
  });
  test("the shell gets surfaces and the accent too", () => {
    expect(cssVarsOf({ ...defaultSettings(), accent: "#e0457b", strength: 0 }, true, true)).toEqual({
      "--text-scale": "1",
      "--surface-a": "0.25",
      "--composer-a": "0.62",
      "--panel-a": "0.95",
      "--accent": "#e0457b",
      "--accent-text": accentText("#e0457b"),
    });
    expect(cssVarsOf({ ...defaultSettings(), acrylic: false }, true)["--surface-a"]).toBe("1");
  });
});

describe("createShellLook", () => {
  function fakeWindow(opts: { refuse?: string[] } = {}) {
    const calls: string[] = [];
    const win: EffectsWindow = {
      setEffects: async (e) => {
        calls.push(`set ${e.effects.join(",")} ${e.color?.join(",")}`);
        if (opts.refuse?.includes(e.effects[0]!)) throw new Error("refused");
      },
      clearEffects: async () => { calls.push("clear"); },
      setAlwaysOnTop: async (v) => { calls.push(`top ${v}`); },
    };
    return { win, calls };
  }
  const base = defaultSettings();

  test("at load: overwrites the effect without clearing (no flash) and sets topmost", async () => {
    const { win, calls } = fakeWindow();
    const look = createShellLook(win, () => true);
    await look.apply(base);
    expect(calls).toEqual(["set acrylic 20,20,20,150", "top true"]);
  });
  test("acrylic off clears the effect; on again re-applies it", async () => {
    const { win, calls } = fakeWindow();
    const look = createShellLook(win, () => true);
    await look.apply(base);
    calls.length = 0;
    await look.apply({ ...base, acrylic: false });
    await look.apply(base);
    expect(calls).toEqual(["clear", "set acrylic 20,20,20,150"]);
  });
  test("switching type clears first; Mica is the dark variant", async () => {
    const { win, calls } = fakeWindow();
    const look = createShellLook(win, () => true);
    await look.apply(base);
    calls.length = 0;
    await look.apply({ ...base, effect: "blur" });
    await look.apply({ ...base, effect: "mica" });
    expect(calls).toEqual(["clear", "set blur 20,20,20,150", "clear", "set micaDark 20,20,20,150"]);
  });
  test("strength re-applies only where the tint shows (blur, or acrylic before Windows 11)", async () => {
    expect(tintMatters("blur", true)).toBe(true);
    expect(tintMatters("acrylic", true)).toBe(false);
    expect(tintMatters("acrylic", false)).toBe(true);
    expect(tintMatters("acrylic", null)).toBe(true);
    expect(tintMatters("mica", false)).toBe(false);
    const w11 = fakeWindow();
    const a = createShellLook(w11.win, () => true);
    await a.apply(base);
    w11.calls.length = 0;
    await a.apply({ ...base, strength: 10 });
    expect(w11.calls).toEqual([]);
    const blur = fakeWindow();
    const b = createShellLook(blur.win, () => true);
    await b.apply({ ...base, effect: "blur" });
    blur.calls.length = 0;
    await b.apply({ ...base, effect: "blur", strength: 10 });
    expect(blur.calls).toEqual(["set blur 20,20,20,50"]);
  });
  test("what is guaranteed: Tauri's setEffects resolves even for an effect the OS refuses (no fallback is possible there); a call the IPC or ACL refuses never throws and leaves the effect unknown, so the next apply tries again", async () => {
    const refused = fakeWindow({ refuse: ["blur"] });
    const look = createShellLook(refused.win, () => true);
    await look.apply({ ...base, effect: "blur" });
    expect(refused.calls).toEqual(["set blur 20,20,20,150", "top true"]);
    expect(look.state().effect).toBeNull();
    refused.calls.length = 0;
    await look.apply({ ...base, effect: "blur", textSize: "large" });
    expect(refused.calls).toEqual(["set blur 20,20,20,150"]);
  });
  test("Mica outside Windows 11 is applied as acrylic", async () => {
    const { win, calls } = fakeWindow();
    await createShellLook(win, () => false).apply({ ...base, effect: "mica" });
    expect(calls[0]).toBe("set acrylic 20,20,20,150");
  });
  test("always on top toggles only when it changes", async () => {
    const { win, calls } = fakeWindow();
    const look = createShellLook(win, () => true);
    await look.apply(base);
    calls.length = 0;
    await look.apply({ ...base, alwaysOnTop: false });
    await look.apply({ ...base, alwaysOnTop: false, textSize: "large" });
    expect(calls).toEqual(["top false"]);
  });
  test("a burst of changes is collapsed: only the latest is applied after the running call", async () => {
    const { win, calls } = fakeWindow();
    const look = createShellLook(win, () => null);
    const p1 = look.apply(base);
    look.apply({ ...base, strength: 10 });
    look.apply({ ...base, strength: 20 });
    await look.apply({ ...base, strength: 30 });
    await p1;
    expect(calls).toEqual(["set acrylic 20,20,20,150", "top true", "set acrylic 20,20,20,90"]);
  });
});

describe("legibility floor where the tint shows (Blur, acrylic before Windows 11)", () => {
  // sRGB relative luminance and WCAG contrast, for a grey level 0-255.
  const lum = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const contrast = (a: number, b: number) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  /** The page background over a white window behind Sidecr: the tint layer, then the page surface, both #141414. */
  const worstBackground = (tint: number, surface: number) => {
    const afterTint = 255 * (1 - tint / 255) + 20 * (tint / 255);
    return afterTint * (1 - surface) + 20 * surface;
  };
  const cases = [
    { effect: "blur", win11: true }, { effect: "blur", win11: false }, { effect: "blur", win11: null },
    { effect: "acrylic", win11: false }, { effect: "acrylic", win11: null },
  ] as const;
  for (const c of cases) {
    test(`${c.effect} (win11 ${c.win11}): at every strength, body text >= 4.5:1 and muted text >= 3:1 over white`, () => {
      expect(tintMatters(c.effect, c.win11)).toBe(true);
      for (const s of [0, 1, 10, 30, 60, 100]) {
        const a = surfaceAlphas(s, true, true);
        const bg = worstBackground(strengthToTint(s), a.surface);
        const combined = 1 - (1 - strengthToTint(s) / 255) * (1 - a.surface);
        expect(combined).toBeGreaterThanOrEqual(MIN_COMBINED_OPACITY - 1e-9);
        expect(contrast(0xec, bg)).toBeGreaterThanOrEqual(4.5); // --fg
        expect(contrast(0xa6, bg)).toBeGreaterThanOrEqual(3); // --muted
        const bubble = bg + (255 - bg) * (0x17 / 255); // a user bubble (#ffffff17) on top
        expect(contrast(0xec, bubble)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  test("the floor raises strength 0 from 0.25 to 0.69 only where the tint shows; Windows 11 acrylic and Mica keep 0.25 (their system backdrop brings its own dark tint)", () => {
    expect(surfaceAlphas(0, true, true).surface).toBe(0.69);
    expect(surfaceAlphas(0, true, false).surface).toBe(0.25);
    expect(tintMatters("acrylic", true)).toBe(false);
    expect(tintMatters("mica", true)).toBe(false);
    expect(tintMatters("mica", false)).toBe(false); // Mica outside Windows 11 is applied as Acrylic: see effectOf
    expect(surfaceAlphas(60, true, true).surface).toBe(0.55); // above the floor: unchanged
  });
  test("cssVarsOf applies the floor from the effect and the Windows version", () => {
    expect(cssVarsOf({ ...defaultSettings(), effect: "blur", strength: 0 }, true, true)["--surface-a"]).toBe("0.69");
    expect(cssVarsOf({ ...defaultSettings(), effect: "acrylic", strength: 0 }, true, true)["--surface-a"]).toBe("0.25");
    expect(cssVarsOf({ ...defaultSettings(), effect: "acrylic", strength: 0 }, true, null)["--surface-a"]).toBe("0.69");
  });
});
