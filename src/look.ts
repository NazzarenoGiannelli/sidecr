/**
 * How the appearance settings turn into numbers: the window effect's tint, the page's surface opacities, the accent
 * pair and the text scale. Pure (no node: imports): the launcher uses it for the shell's start arguments and the
 * window bundles it to apply the same values live.
 */
import type { Settings } from "./settings-schema";

/** The tint colour behind the window effect (the alpha comes from the strength). */
export const TINT_RGB = [20, 20, 20] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const strengthOf = (s: number) => clamp(Number.isFinite(s) ? s : 60, 0, 100);

/**
 * The alpha (0-255) of the tint colour passed to the window effect. 0 gives 30 (most see-through), the default 60
 * gives 150 (the shell's original tint), 100 gives 230. Windows 11's own acrylic ignores the colour (it uses the
 * system backdrop); the tint matters for blur and for acrylic on older builds.
 */
export function strengthToTint(strength: number): number {
  return Math.round(30 + 2 * strengthOf(strength));
}

/** The lowest opacity of the composer and the attachment chips: they stay readable over any desktop. */
export const MIN_COMPOSER_ALPHA = 0.62;
/** The lowest opacity of the switcher, settings and cheat sheet panels. */
export const MIN_PANEL_ALPHA = 0.95;

/**
 * Where the tint shows (Blur, and acrylic before Windows 11), what is behind Sidecr shows through two #141414 layers:
 * the tint and the page surface. Their combined opacity o = 1 - (1 - tint) * (1 - surface) puts the page background
 * over a white window at 255 - 235 * o. For the muted text (#a6a6a6) to keep 3:1 that background must be at most 86,
 * so o >= 0.72; the body text (#ececec) then has about 6:1, and over a user bubble (#ffffff17) still above 4.5:1.
 * Windows 11's acrylic and Mica draw their own dark system backdrop (they ignore the tint), so no floor there.
 */
export const MIN_COMBINED_OPACITY = 0.72;

export interface SurfaceAlphas {
  /** The page background (behind the conversation). */
  surface: number;
  /** The composer and the attachment chips. */
  composer: number;
  /** The overlay panels. */
  panel: number;
}

/**
 * The CSS opacities of the shell's surfaces. With the translucent background on, the page background goes from 0.25
 * at strength 0 through 0.55 at the default 60 (the original look) to 0.95 at 100; where the tint shows
 * (`tintShows`) it never goes below what MIN_COMBINED_OPACITY needs with that strength's tint (0.69 at strength 0).
 * The composer is always at least MIN_COMPOSER_ALPHA and a step denser than the page; panels are near opaque.
 * Off: everything opaque.
 */
export function surfaceAlphas(strength: number, translucent: boolean, tintShows = false): SurfaceAlphas {
  if (!translucent) return { surface: 1, composer: 1, panel: 1 };
  const s = strengthOf(strength);
  let surface = s <= 60 ? 0.25 + 0.005 * s : 0.55 + 0.01 * (s - 60);
  if (tintShows) {
    // Rounded up to the next hundredth, so the rounded value still meets the floor.
    const floor = Math.ceil((1 - (1 - MIN_COMBINED_OPACITY) / (1 - strengthToTint(s) / 255)) * 100) / 100;
    surface = Math.max(surface, floor);
  }
  return {
    surface: round2(surface),
    composer: round2(clamp(surface + 0.15, MIN_COMPOSER_ALPHA, 0.97)),
    panel: round2(Math.max(MIN_PANEL_ALPHA, surface)),
  };
}

/** The accent as text on the dark shell: the colour mixed 40 % with white, so links and the "working" label read on dark. */
export function accentText(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#9a92ff";
  const n = parseInt(m[1]!, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.4);
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export const TEXT_SCALE: Record<Settings["textSize"], number> = { small: 0.92, medium: 1, large: 1.12 };

export type ShellEffect = "acrylic" | "mica" | "blur" | "none";

/**
 * The window effect to apply. Translucency off: none. Mica is Windows 11 only: on another version
 * (`win11 === false`) it falls back to Acrylic. Blur works from Windows 10 (1809) and is kept. When the version is
 * unknown (null) the user's choice is kept. Nothing can be checked after the fact: Tauri's setEffects drops the OS's
 * refusal and always resolves, so this version check is the only fallback there is.
 */
export function effectOf(s: Pick<Settings, "acrylic" | "effect">, win11: boolean | null = null): ShellEffect {
  if (!s.acrylic) return "none";
  if (s.effect === "mica" && win11 === false) return "acrylic";
  return s.effect;
}

/** Whether the tint's alpha shows: Windows 11's acrylic and Mica ignore the colour, Blur and older acrylic use it. */
export function tintMatters(effect: ShellEffect, win11: boolean | null): boolean {
  if (effect === "blur") return true;
  if (effect === "acrylic") return win11 !== true;
  return false;
}

/** The Tauri `Effect` value for a setting. The page is dark only, so Mica is the dark variant. */
export function tauriEffect(e: Exclude<ShellEffect, "none">): string {
  return e === "mica" ? "micaDark" : e;
}

/** Windows 11 from `navigator.userAgentData`'s platform version (major 13 and up), null when unknown. */
export function isWindows11(platform: string | undefined, platformVersion: string | undefined): boolean | null {
  if (platform !== "Windows" || !platformVersion) return null;
  const major = Number(platformVersion.split(".")[0]);
  return Number.isFinite(major) ? major >= 13 : null;
}
