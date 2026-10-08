/**
 * The settings schema: the single source of truth for every setting (id, type, default, allowed values or range,
 * label, group). The server validates with it and sends it to the window, which renders the settings panel from it.
 * Pure (no node: imports): the window bundles it too, to read its cached copy before the server answers.
 */

export type GroupId = "appearance" | "window" | "behaviour";

export interface GroupDef {
  id: GroupId;
  label: string;
  /** Only meaningful in the native shell; the Chromium window hides the whole group. */
  shellOnly: boolean;
}

export const GROUPS: readonly GroupDef[] = [
  { id: "appearance", label: "Appearance", shellOnly: true },
  { id: "window", label: "Window", shellOnly: true },
  { id: "behaviour", label: "Behaviour", shellOnly: false },
];

export interface Choice<V extends string | number = string | number> {
  value: V;
  label: string;
}

interface Common {
  label: string;
  group: GroupId;
  /** One line under the control, optional. */
  hint?: string;
}

export type SettingDef =
  | (Common & { id: string; type: "boolean"; default: boolean })
  | (Common & { id: string; type: "choice"; default: string | number; choices: Choice[] })
  | (Common & { id: string; type: "color"; default: string; choices: Choice<string>[] })
  | (Common & { id: string; type: "range"; default: number; min: number; max: number; step: number });

/** The accent palette: the current Sidecr indigo first. Lowercase hex, compared case-insensitively. */
export const ACCENTS: readonly Choice<string>[] = [
  { value: "#5347fd", label: "Indigo" },
  { value: "#2f7cf6", label: "Blue" },
  { value: "#0f9f8f", label: "Teal" },
  { value: "#2f9e44", label: "Green" },
  { value: "#d9822b", label: "Amber" },
  { value: "#e0457b", label: "Rose" },
];

export interface Settings {
  acrylic: boolean;
  effect: "acrylic" | "mica" | "blur";
  strength: number;
  accent: string;
  alwaysOnTop: boolean;
  notifyOnFinish: boolean;
  exchangesShown: 3 | 5 | 10;
  loadBlock: 5 | 10 | 20;
  textSize: "small" | "medium" | "large";
  sendKey: "enter" | "ctrl-enter";
  followFocus: "auto" | "idle" | "off";
}

export type SettingId = keyof Settings;

export const SCHEMA: readonly (SettingDef & { id: SettingId })[] = [
  { id: "acrylic", type: "boolean", default: true, label: "Translucent background", group: "appearance", hint: "Off paints solid surfaces." },
  {
    id: "effect",
    type: "choice",
    default: "acrylic",
    label: "Effect",
    group: "appearance",
    choices: [
      { value: "acrylic", label: "Acrylic" },
      { value: "mica", label: "Mica" },
      { value: "blur", label: "Blur" },
    ],
    hint: "Mica needs Windows 11 (Acrylic elsewhere); Blur works from Windows 10.",
  },
  { id: "strength", type: "range", default: 60, min: 0, max: 100, step: 1, label: "Strength", group: "appearance", hint: "0 is the most see-through, 100 nearly opaque." },
  { id: "accent", type: "color", default: "#5347fd", label: "Accent", group: "appearance", choices: [...ACCENTS] },
  { id: "alwaysOnTop", type: "boolean", default: true, label: "Always on top", group: "window" },
  { id: "notifyOnFinish", type: "boolean", default: true, label: "Notify when Claude finishes", group: "behaviour", hint: "Only while the window is in the background." },
  {
    id: "exchangesShown",
    type: "choice",
    default: 5,
    label: "Exchanges shown",
    group: "behaviour",
    choices: [
      { value: 3, label: "3" },
      { value: 5, label: "5" },
      { value: 10, label: "10" },
    ],
    hint: "How many of the latest exchanges the conversation shows.",
  },
  {
    id: "loadBlock",
    type: "choice",
    default: 10,
    label: "Earlier exchanges per load",
    group: "behaviour",
    choices: [
      { value: 5, label: "5" },
      { value: 10, label: "10" },
      { value: 20, label: "20" },
    ],
    hint: "How many older exchanges come in when you scroll to the top.",
  },
  {
    id: "textSize",
    type: "choice",
    default: "medium",
    label: "Text size",
    group: "behaviour",
    choices: [
      { value: "small", label: "Small" },
      { value: "medium", label: "Medium" },
      { value: "large", label: "Large" },
    ],
  },
  {
    id: "sendKey",
    type: "choice",
    default: "enter",
    label: "Send with",
    group: "behaviour",
    choices: [
      { value: "enter", label: "Enter" },
      { value: "ctrl-enter", label: "Ctrl+Enter" },
    ],
    hint: "Shift+Enter always inserts a new line.",
  },
  {
    id: "followFocus",
    type: "choice",
    default: "idle",
    label: "Follow the pane selected in herdr",
    group: "behaviour",
    choices: [
      { value: "auto", label: "Always" },
      { value: "idle", label: "When idle" },
      { value: "off", label: "Off" },
    ],
    hint: "When idle: only while the composer is empty and nothing is attached. Ctrl+Shift+L pins the current session.",
  },
];

export function defaultSettings(): Settings {
  const out: Record<string, unknown> = {};
  for (const def of SCHEMA) out[def.id] = def.default;
  return out as unknown as Settings;
}

/** The value as this setting stores it, or undefined when it is not allowed. Never throws. */
export function validValue(def: SettingDef, v: unknown): unknown {
  switch (def.type) {
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "choice":
      return def.choices.some((c) => c.value === v) ? v : undefined;
    case "color": {
      if (typeof v !== "string") return undefined;
      const lower = v.toLowerCase();
      return def.choices.some((c) => c.value === lower) ? lower : undefined;
    }
    case "range": {
      if (typeof v !== "number" || !Number.isFinite(v) || v < def.min || v > def.max) return undefined;
      const stepped = def.min + Math.round((v - def.min) / def.step) * def.step;
      return Math.min(def.max, Math.max(def.min, stepped));
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A full, valid set from anything: unknown keys dropped, a missing or invalid value replaced by its default. */
export function validateSettings(raw: unknown): Settings {
  const src = isObject(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const def of SCHEMA) {
    const v = Object.hasOwn(src, def.id) ? validValue(def, src[def.id]) : undefined;
    out[def.id] = v === undefined ? def.default : v;
  }
  return out as unknown as Settings;
}

/**
 * A partial update over the current settings, validated per key: a valid value replaces the current one; an invalid
 * value or an unknown key leaves everything as it was and is listed in `rejected`. A patch that is not an object
 * changes nothing (`rejected: ["*"]`).
 */
export function applyPatch(current: Settings, patch: unknown): { settings: Settings; rejected: string[] } {
  if (!isObject(patch)) return { settings: { ...current }, rejected: ["*"] };
  const next: Record<string, unknown> = { ...current };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const def = SCHEMA.find((d) => d.id === key);
    const v = def ? validValue(def, value) : undefined;
    if (v === undefined) rejected.push(key);
    else next[key] = v;
  }
  return { settings: next as unknown as Settings, rejected };
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return SCHEMA.every((d) => a[d.id] === b[d.id]);
}
