/**
 * Every in-window keyboard shortcut, defined once. The window's key handler (matchShortcut), the cheat sheet
 * (cheatSheet) and the tooltips (tooltip) are all driven from this list. Pure: no DOM.
 *
 * An entry whose handler is an Action is matched and dispatched by ui/app.ts. The others are listed so the cheat
 * sheet is complete, and are handled where they live: "composer" (Enter/recall in the textarea), "escape" (the Esc
 * layering in ui/escape.ts), "lightbox-window" (the shell's fullscreen image window), "media-panel" (the Media &
 * links panel's own keys, ui/media-panel.ts), "mouse" and "herdr" (the herdr key binding that opens the window,
 * outside the page).
 */
import type { Settings } from "../src/settings-schema";

export type KeyGroup = "Sessions" | "Messages" | "Images" | "Window" | "Settings";
export const KEY_GROUPS: readonly KeyGroup[] = ["Sessions", "Messages", "Images", "Window", "Settings"];

export type Action =
  | "switcher"
  | "settings"
  | "cheatsheet"
  | "prev-pane"
  | "next-pane"
  | "nth-pane"
  | "scroll-bottom"
  | "copy-answer"
  | "close"
  | "lightbox-fullscreen"
  | "media"
  | "follow-pin"
  | "follow-now"
  | "always-on-top";

export type Handler = Action | "composer" | "escape" | "lightbox-window" | "mouse" | "herdr" | "media-panel";

/** Where a shortcut applies: with the in-page lightbox closed ("main"), open ("lightbox"), or both ("always"). */
export type When = "main" | "lightbox" | "always";

/** One key combination. `code` is the physical key (layout independent), `key` the produced character or key name. */
export interface Chord {
  code?: string;
  key?: string;
  /** Ctrl (or Cmd). */
  mod?: boolean;
  alt?: boolean;
  /** true, false (the default), or "any" for a character that needs Shift on some layouts ("?", "/"). */
  shift?: boolean | "any";
  /** Overrides the entry's whileTyping for this chord ("?" types a question mark in the composer). */
  whileTyping?: boolean;
  /** Passed to the action (Alt+1..9: the number). */
  arg?: number;
  /**
   * A `code` fallback that applies only to an event with no character (key "" or "Unidentified"). A real keyboard
   * always reports a key, which then has to match by key, so the physical key never takes over another character
   * (the US Slash key is "-" on the Italian and German layouts, and Ctrl+- is the browser's zoom out).
   */
  keyless?: boolean;
}

export interface Shortcut {
  id: string;
  /** The key chips shown in the cheat sheet and in tooltips, one per alternative. */
  keys: string[];
  /** The cheat sheet's description. */
  label: string;
  /** The tooltip text before the key, when it differs from the label. */
  tip?: string;
  group: KeyGroup;
  handler: Handler;
  /** What the key handler matches; empty for entries handled elsewhere. */
  chords: Chord[];
  when: When;
  /** Whether it applies while focus is in a text field (the composer, the switcher's search). */
  whileTyping: boolean;
  /** false lets the browser's own action happen too (Ctrl+End also moves the caret in the composer). */
  preventDefault?: boolean;
  /** A key of herdr itself (not of this page): listed at the top of the cheat sheet. */
  herdr?: boolean;
  /** Only in the native shell. */
  shellOnly?: boolean;
}

const digits: Chord[] = Array.from({ length: 9 }, (_, i) => ({ code: `Digit${i + 1}`, alt: true, arg: i + 1 }));

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "herdr-toggle", keys: ["Alt+S"], label: "Open or close Sidecr", group: "Window", handler: "herdr", chords: [], when: "always", whileTyping: true, herdr: true },
  // Sessions
  {
    id: "switcher",
    keys: ["Ctrl+K", "Ctrl+Shift+K"],
    label: "Switch session",
    group: "Sessions",
    handler: "switcher",
    chords: [{ code: "KeyK", mod: true }, { code: "KeyK", mod: true, shift: true }],
    when: "main",
    whileTyping: true,
  },
  { id: "prev-pane", keys: ["Alt+↑"], label: "Previous session in the list", group: "Sessions", handler: "prev-pane", chords: [{ key: "ArrowUp", alt: true }], when: "main", whileTyping: true },
  { id: "next-pane", keys: ["Alt+↓"], label: "Next session in the list", group: "Sessions", handler: "next-pane", chords: [{ key: "ArrowDown", alt: true }], when: "main", whileTyping: true },
  { id: "nth-pane", keys: ["Alt+1…9"], label: "Session 1 to 9 of the list", group: "Sessions", handler: "nth-pane", chords: digits, when: "main", whileTyping: true },
  {
    id: "follow-pin",
    keys: ["Ctrl+Shift+L"],
    label: "Pin this session, or follow the pane selected in herdr again",
    tip: "Following herdr",
    group: "Sessions",
    handler: "follow-pin",
    chords: [{ code: "KeyL", mod: true, shift: true }],
    when: "main",
    whileTyping: true,
  },
  {
    id: "follow-now",
    keys: ["Alt+."],
    label: "Go to the pane selected in herdr",
    tip: "Switch",
    group: "Sessions",
    handler: "follow-now",
    chords: [{ code: "Period", alt: true }],
    when: "main",
    whileTyping: true,
  },
  // Messages
  { id: "send", keys: ["Enter"], label: "Send", group: "Messages", handler: "composer", chords: [], when: "main", whileTyping: true },
  { id: "newline", keys: ["Shift+Enter"], label: "New line", group: "Messages", handler: "composer", chords: [], when: "main", whileTyping: true },
  { id: "recall", keys: ["↑", "↓"], label: "Recall your earlier messages (empty composer)", group: "Messages", handler: "composer", chords: [], when: "main", whileTyping: true },
  {
    id: "scroll-bottom",
    keys: ["Ctrl+End"],
    label: "Scroll to the bottom",
    group: "Messages",
    handler: "scroll-bottom",
    chords: [{ key: "End", mod: true }],
    when: "main",
    whileTyping: true,
    preventDefault: false,
  },
  { id: "copy-answer", keys: ["Ctrl+Shift+C"], label: "Copy the last answer as Markdown", group: "Messages", handler: "copy-answer", chords: [{ code: "KeyC", mod: true, shift: true }], when: "main", whileTyping: true },
  { id: "open-folder", keys: ["Click"], label: "Open a folder link in the file manager", group: "Messages", handler: "mouse", chords: [], when: "main", whileTyping: true },
  { id: "reveal-file", keys: ["Shift+Click"], label: "Show a file link in its folder", group: "Messages", handler: "mouse", chords: [], when: "main", whileTyping: true },
  // Images
  { id: "open-image", keys: ["Click"], label: "Open an image", group: "Images", handler: "mouse", chords: [], when: "main", whileTyping: true },
  { id: "open-image-fullscreen", keys: ["Shift+Click"], label: "Open an image fullscreen", group: "Images", handler: "mouse", chords: [], when: "main", whileTyping: true },
  { id: "lightbox-fullscreen", keys: ["F"], label: "Fullscreen on or off (open image)", tip: "Fullscreen", group: "Images", handler: "lightbox-fullscreen", chords: [{ key: "f" }], when: "lightbox", whileTyping: false },
  {
    id: "media",
    keys: ["Ctrl+Shift+M"],
    label: "Media & links of this session",
    tip: "Media & links",
    group: "Images",
    handler: "media",
    chords: [{ code: "KeyM", mod: true, shift: true }],
    when: "main",
    whileTyping: true,
  },
  { id: "media-tabs", keys: ["←", "→", "1", "2"], label: "Images or Links tab (Media & links open)", group: "Images", handler: "media-panel", chords: [], when: "main", whileTyping: false },
  { id: "lightbox-step", keys: ["←", "→"], label: "Previous or next image (fullscreen)", group: "Images", handler: "lightbox-window", chords: [], when: "lightbox", whileTyping: false, shellOnly: true },
  // Window
  {
    id: "close",
    keys: ["Alt+S", "Ctrl+Shift+J"],
    label: "Close Sidecr",
    tip: "Close",
    group: "Window",
    handler: "close",
    chords: [{ code: "KeyS", alt: true }, { code: "KeyJ", mod: true, shift: true }],
    when: "always",
    whileTyping: true,
  },
  {
    id: "always-on-top",
    keys: ["Ctrl+Shift+T"],
    label: "Toggle always on top",
    tip: "Always on top",
    group: "Window",
    handler: "always-on-top",
    chords: [{ code: "KeyT", mod: true, shift: true }],
    when: "main",
    whileTyping: true,
    shellOnly: true,
  },
  { id: "escape", keys: ["Esc"], label: "Close the top layer; with nothing open and an empty composer, close Sidecr", group: "Window", handler: "escape", chords: [], when: "always", whileTyping: true },
  // Settings
  { id: "settings", keys: ["Ctrl+,"], label: "Settings", group: "Settings", handler: "settings", chords: [{ key: ",", mod: true }], when: "main", whileTyping: true },
  {
    id: "cheatsheet",
    keys: ["Ctrl+/", "?"],
    label: "Keyboard shortcuts",
    group: "Settings",
    handler: "cheatsheet",
    // Ctrl+/ by the character. The physical-key chords (the US Slash key, the Italian Shift+7) only cover events
    // that carry no character at all, as synthesised ones (CDP) can; see Chord.keyless.
    chords: [
      { key: "/", mod: true, shift: "any" },
      { code: "Slash", mod: true, shift: "any", keyless: true },
      { code: "Digit7", mod: true, shift: true, keyless: true },
      { key: "?", shift: "any", whileTyping: false },
    ],
    when: "main",
    whileTyping: true,
  },
];

/** The parts of a KeyboardEvent the matcher looks at. */
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
  /** Focus is in a text field. */
  typing: boolean;
  /** The in-page lightbox is open. */
  lightboxOpen: boolean;
  /** The page runs in the native shell. Shell-only shortcuts are not matched elsewhere (the browser keeps the key). */
  inShell?: boolean;
}

/**
 * Whether the event is this chord. Modifiers must match exactly (Ctrl and Cmd count as one), so AltGr (Ctrl and Alt
 * together) never triggers an Alt or a Ctrl chord and stays free for typing characters. A one-character key is
 * compared without case.
 */
export function chordMatches(c: Chord, e: KeyLike): boolean {
  if (e.isComposing) return false;
  if (Boolean(c.mod) !== (e.ctrlKey || e.metaKey)) return false;
  if (Boolean(c.alt) !== e.altKey) return false;
  if (c.shift !== "any" && Boolean(c.shift) !== e.shiftKey) return false;
  if (c.keyless && e.key !== "" && e.key !== "Unidentified") return false;
  if (c.code) return e.code === c.code;
  if (c.key) return e.key.length === 1 ? e.key.toLowerCase() === c.key.toLowerCase() : e.key === c.key;
  return false;
}

const applies = (when: When, lightboxOpen: boolean) => when === "always" || (when === "lightbox") === lightboxOpen;

/** The shortcut this key press triggers, with its chord, or null. Auto-repeated presses never trigger one. */
export function matchShortcut(e: KeyLike, ctx: KeyContext, list: readonly Shortcut[] = SHORTCUTS): { shortcut: Shortcut; chord: Chord } | null {
  if (e.repeat || e.isComposing) return null;
  for (const s of list) {
    if (s.shellOnly && !ctx.inShell) continue;
    if (!applies(s.when, ctx.lightboxOpen)) continue;
    for (const c of s.chords) {
      if (ctx.typing && !(c.whileTyping ?? s.whileTyping)) continue;
      if (chordMatches(c, e)) return { shortcut: s, chord: c };
    }
  }
  return null;
}

/** Canonical names of what a chord binds, per context, for the duplicate check ("any" Shift binds both). */
export function chordSignatures(s: Shortcut, c: Chord): string[] {
  const contexts = s.when === "always" ? ["main", "lightbox"] : [s.when];
  const shifts = c.shift === "any" ? [false, true] : [Boolean(c.shift)];
  const id = c.code ? `code:${c.code}` : `key:${(c.key ?? "").length === 1 ? (c.key ?? "").toLowerCase() : c.key}`;
  const out: string[] = [];
  for (const ctx of contexts) for (const sh of shifts) out.push(`${ctx}|${c.mod ? "mod+" : ""}${c.alt ? "alt+" : ""}${sh ? "shift+" : ""}${id}`);
  return out;
}

/** The chords bound twice in the same context, as "signature: id1, id2". Empty when the registry is clean. */
export function conflicts(list: readonly Shortcut[] = SHORTCUTS): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const s of list) {
    for (const c of s.chords) {
      for (const sig of chordSignatures(s, c)) {
        const prev = seen.get(sig);
        if (prev !== undefined && prev !== s.id) out.push(`${sig}: ${prev}, ${s.id}`);
        else seen.set(sig, s.id);
      }
    }
  }
  return out;
}

/** The keys shown for a shortcut under the current settings: Send and New line follow `sendKey`. */
export function keysFor(s: Shortcut, settings?: Pick<Settings, "sendKey">): string[] {
  const ctrlEnter = settings?.sendKey === "ctrl-enter";
  if (s.id === "send") return ctrlEnter ? ["Ctrl+Enter"] : ["Enter"];
  if (s.id === "newline") return ctrlEnter ? ["Enter", "Shift+Enter"] : ["Shift+Enter"];
  return s.keys;
}

export function shortcutById(id: string, list: readonly Shortcut[] = SHORTCUTS): Shortcut {
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`no shortcut ${id}`);
  return s;
}

/** A button's tooltip: "Settings (Ctrl+,)". The first key alternative is shown. */
export function tooltip(id: string, settings?: Pick<Settings, "sendKey">): string {
  const s = shortcutById(id);
  return tooltipWith(id, s.tip ?? s.label, settings);
}

/** A tooltip whose text changes with the state ("Pinned to morning (Ctrl+Shift+L)"); the key still comes from here. */
export function tooltipWith(id: string, text: string, settings?: Pick<Settings, "sendKey">): string {
  return `${text} (${keysFor(shortcutById(id), settings)[0]})`;
}

export interface CheatRow {
  id: string;
  keys: string[];
  label: string;
  herdr?: boolean;
}

export interface CheatSheet {
  /** herdr's own keys, shown first and marked as such. */
  top: CheatRow[];
  groups: { group: KeyGroup; rows: CheatRow[] }[];
}

/** The cheat sheet: herdr keys at the top, then every other entry in its group, in registry order. */
export function cheatSheet(opts: { inShell: boolean; settings?: Pick<Settings, "sendKey"> }, list: readonly Shortcut[] = SHORTCUTS): CheatSheet {
  const shown = list.filter((s) => opts.inShell || !s.shellOnly);
  const row = (s: Shortcut): CheatRow => ({ id: s.id, keys: keysFor(s, opts.settings), label: s.label, ...(s.herdr ? { herdr: true } : {}) });
  return {
    top: shown.filter((s) => s.herdr).map(row),
    groups: KEY_GROUPS.map((group) => ({ group, rows: shown.filter((s) => !s.herdr && s.group === group).map(row) })).filter((g) => g.rows.length > 0),
  };
}

/** What a key press in the composer does under the `sendKey` setting. Shift+Enter is always a new line. */
export function composerKey(e: KeyLike, sendKey: Settings["sendKey"]): "send" | "newline" | "pass" {
  if (e.key !== "Enter" || e.isComposing || e.altKey) return "pass";
  if (e.shiftKey) return "newline";
  const mod = e.ctrlKey || e.metaKey;
  if (sendKey === "ctrl-enter") return mod ? "send" : "newline";
  return "send"; // Enter, and Ctrl+Enter too
}
