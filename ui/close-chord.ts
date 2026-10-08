import { chordMatches, shortcutById } from "./keys";

/** The parts of a KeyboardEvent that decide whether it closes the window. */
export interface ChordEvent {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** True while an input method (IME) is composing text: a key then belongs to the composition. */
  isComposing?: boolean;
}

/**
 * Alt+S (the same key that opens the window) or Ctrl/Cmd+Shift+J closes it: the "close" entry of the key registry
 * (ui/keys.ts). The physical key (`code`) decides, so Caps Lock and other layouts do not matter. Any extra modifier
 * means it is something else; in particular AltGr arrives as ctrl and alt together and must stay free for typing.
 */
export function isCloseChord(e: ChordEvent): boolean {
  return shortcutById("close").chords.some((c) => chordMatches(c, e));
}
