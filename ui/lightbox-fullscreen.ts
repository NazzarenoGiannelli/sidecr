import type { IconName } from "./icons";

/** An Esc that arrives this soon after fullscreen ended is the same keypress that ended it. */
export const ESC_GUARD_MS = 250;

/** The parts of a KeyboardEvent the lightbox shortcuts look at. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export interface KeyContext {
  lightboxOpen: boolean;
  /** Focus is in a text field: F is a letter there. */
  typing: boolean;
}

/**
 * What the page should do with a key press:
 * "toggle" enters or leaves fullscreen, "exit" leaves it (Esc, and nothing else happens),
 * "swallow" ignores an Esc that belongs to the keypress that already left fullscreen,
 * "pass" is not ours (the normal Esc layering and other shortcuts go on).
 */
export type LightboxKeyAction = "toggle" | "exit" | "swallow" | "pass";

export interface FullscreenDeps {
  now(): number;
}

/** The state machine behind the lightbox's fullscreen: which real state it is in, and what a key means in it. */
export function createLightboxFullscreen(deps: FullscreenDeps) {
  let fullscreen = false;
  let exitedAt: number | null = null;
  return {
    fullscreen: (): boolean => fullscreen,
    /** The `fullscreenchange` handler passes the real state; it is the only thing that sets it. */
    changed(isFullscreen: boolean): void {
      if (fullscreen && !isFullscreen) exitedAt = deps.now();
      fullscreen = isFullscreen;
    },
    /** True when closing the lightbox has to leave fullscreen too. */
    shouldExitOnClose: (): boolean => fullscreen,
    key(e: KeyLike, ctx: KeyContext): LightboxKeyAction {
      if (!ctx.lightboxOpen || e.isComposing) return "pass";
      if (e.key === "Escape") {
        if (fullscreen) return "exit";
        if (exitedAt !== null) {
          const recent = deps.now() - exitedAt < ESC_GUARD_MS;
          exitedAt = null; // used up by the keypress it belonged to, or too old to matter
          if (recent) return "swallow";
        }
        return "pass";
      }
      const plainF = (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plainF && !ctx.typing && !e.repeat) return "toggle";
      return "pass";
    },
  };
}

/** The icon and label of the fullscreen button for the real state. */
export function fullscreenButton(isFullscreen: boolean): { icon: IconName; label: string } {
  return isFullscreen ? { icon: "corners-in", label: "Leave fullscreen (F)" } : { icon: "corners-out", label: "Fullscreen (F)" };
}
