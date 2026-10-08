/**
 * Applying the appearance settings: CSS variables for the page (both windows) and, in the native shell, the window
 * effect and the always-on-top flag through the Tauri window API (no app command: the capability grants exactly
 * set-effects and set-always-on-top to the loopback page). Pure apart from the injected window and style target.
 */
import { accentText, effectOf, strengthToTint, surfaceAlphas, tauriEffect, TEXT_SCALE, tintMatters, TINT_RGB, type ShellEffect } from "../src/look";
import type { Settings } from "../src/settings-schema";

/**
 * The CSS custom properties the settings set on <html>. Appearance only applies inside the shell; `win11` decides
 * whether the effect's tint shows, and with it the legibility floor of the surfaces (see MIN_COMBINED_OPACITY).
 */
export function cssVarsOf(s: Settings, inShell: boolean, win11: boolean | null = null): Record<string, string> {
  const vars: Record<string, string> = { "--text-scale": String(TEXT_SCALE[s.textSize]) };
  if (inShell) {
    const a = surfaceAlphas(s.strength, s.acrylic, tintMatters(effectOf(s, win11), win11));
    vars["--surface-a"] = String(a.surface);
    vars["--composer-a"] = String(a.composer);
    vars["--panel-a"] = String(a.panel);
    vars["--accent"] = s.accent;
    vars["--accent-text"] = accentText(s.accent);
  }
  return vars;
}

/** The part of the Tauri window API the look needs. */
export interface EffectsWindow {
  setEffects(effects: { effects: string[]; color?: [number, number, number, number] }): Promise<void>;
  clearEffects(): Promise<void>;
  setAlwaysOnTop(onTop: boolean): Promise<void>;
}

export function isEffectsWindow(w: unknown): w is EffectsWindow {
  const x = w as Partial<EffectsWindow> | null;
  return !!x && typeof x.setEffects === "function" && typeof x.clearEffects === "function" && typeof x.setAlwaysOnTop === "function";
}

/**
 * The shell window's effect and topmost flag, kept in step with the settings. Calls are serialised and collapsed
 * (dragging the slider sends many changes; only the latest is applied once the previous call is done). The effect
 * is cleared before switching type (applying blur over acrylic would leave both on); at load the type the shell
 * was started with is unknown, so the first apply only overwrites (no flash when it is the same). Tauri's
 * setEffects drops the OS's refusal of an effect and resolves anyway, so there is nothing to fall back from here
 * (effectOf's version check is the fallback); a call refused by the IPC or the ACL leaves the effect unknown, so
 * the next apply tries again. Nothing here throws.
 */
export function createShellLook(win: EffectsWindow, win11: () => boolean | null) {
  let lastEffect: ShellEffect | null = null; // null: unknown (what the shell was started with)
  let lastTint: number | null = null;
  let lastTop: boolean | null = null;
  let wanted: Settings | null = null;
  let running: Promise<void> | null = null;

  async function applyOnce(s: Settings): Promise<void> {
    const w11 = win11();
    const effect = effectOf(s, w11);
    const tint = strengthToTint(s.strength);
    const typeChanged = effect !== lastEffect;
    const tintChanged = tint !== lastTint && tintMatters(effect, w11);
    if (effect === "none") {
      if (typeChanged) await win.clearEffects().catch(() => {});
      lastEffect = "none";
    } else if (typeChanged || tintChanged) {
      if (typeChanged && lastEffect !== null && lastEffect !== "none") await win.clearEffects().catch(() => {});
      try {
        await win.setEffects({ effects: [tauriEffect(effect)], color: [TINT_RGB[0], TINT_RGB[1], TINT_RGB[2], tint] });
        lastEffect = effect;
        lastTint = tint;
      } catch {
        lastEffect = null; // refused by the IPC or the ACL: unknown, the next apply tries again
        lastTint = null;
      }
    }
    if (s.alwaysOnTop !== lastTop) {
      lastTop = s.alwaysOnTop;
      await win.setAlwaysOnTop(s.alwaysOnTop).catch(() => {});
    }
  }

  return {
    /** Resolves when the window matches the latest settings asked for. Never rejects. */
    apply(s: Settings): Promise<void> {
      wanted = s;
      running ??= (async () => {
        try {
          while (wanted) {
            const next = wanted;
            wanted = null;
            await applyOnce(next);
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
    state: () => ({ effect: lastEffect, tint: lastTint, alwaysOnTop: lastTop }),
  };
}
