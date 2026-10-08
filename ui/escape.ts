export type EscapeLayer = "lightbox" | "overlay" | "settings" | "cheatsheet" | "media" | "tray" | "notice" | "close" | "none";

export interface EscapeState {
  lightboxOpen: boolean;
  /** The session switcher. */
  overlayOpen: boolean;
  settingsOpen?: boolean;
  cheatSheetOpen?: boolean;
  /** The Media & links panel (an image opened from it is the lightbox, above it). */
  mediaOpen?: boolean;
  trayCount: number;
  noticeShown?: boolean;
  /** The composer holds no text (whitespace counts as none). Undefined: unknown, never closes. */
  composerEmpty?: boolean;
  /** The key is auto-repeating (held down): only the first press acts. */
  repeat?: boolean;
}

/**
 * Which layer Esc should act on, in visual order: lightbox, switcher, settings, cheat sheet, Media & links, the attachment tray,
 * a timed notice. With none of them and an empty composer, Esc closes Sidecr ("close"): open with Alt+S, type,
 * send, Esc, back in the terminal. A draft in the composer keeps the window open. An auto-repeated Esc does nothing.
 */
export function escapeLayer(s: EscapeState): EscapeLayer {
  // Holding Esc to close the switcher must not go on to close the next layer, and finally Sidecr.
  if (s.repeat) return "none";
  if (s.lightboxOpen) return "lightbox";
  if (s.overlayOpen) return "overlay";
  if (s.settingsOpen) return "settings";
  if (s.cheatSheetOpen) return "cheatsheet";
  if (s.mediaOpen) return "media";
  if (s.trayCount > 0) return "tray";
  if (s.noticeShown) return "notice";
  if (s.composerEmpty === true) return "close";
  return "none";
}
