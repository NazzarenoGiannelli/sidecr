// The settings panel and the cheat sheet: overlay panels built node by node (never from markup) from the server's
// schema and the key registry. The decisions live in the pure modules (settings-schema, settings-client, keys).
import type { GroupDef, SettingDef, Settings, SettingId } from "../src/settings-schema";
import { createIcon } from "./icons";
import type { CheatRow, CheatSheet } from "./keys";

export interface SettingsModel {
  schema: { groups: GroupDef[]; settings: SettingDef[] };
  about: { version: string; stateDir: string };
}

export interface SettingsPanelDeps {
  /** The panel element inside the overlay. */
  root: HTMLElement;
  inShell: boolean;
  change(id: SettingId, value: unknown, opts?: { debounce?: boolean }): void;
  reset(): void;
  openShortcuts(): void;
  /** The tooltip of the "Keyboard shortcuts" entry, from the key registry. */
  shortcutsTip: string;
  close(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Settings that only make sense with the translucent background on. */
/** The x at the top right of a panel (mouse users; Esc does the same). */
function closeButton(onClick: () => void): HTMLButtonElement {
  const b = el("button", "icon-btn panel-close");
  b.type = "button";
  b.title = "Close (Esc)";
  b.setAttribute("aria-label", "Close");
  b.append(createIcon("x"));
  b.onclick = onClick;
  return b;
}

const NEEDS_TRANSLUCENT: ReadonlySet<string> = new Set(["effect", "strength"]);

export function createSettingsPanel(deps: SettingsPanelDeps) {
  const updaters = new Map<string, (s: Settings) => void>();
  let firstFocus: HTMLElement | null = null;

  function row(def: SettingDef, control: HTMLElement): HTMLElement {
    const r = el("div", "set-row");
    const text = el("div", "set-text");
    const label = el("span", "set-label", def.label);
    label.id = `set-label-${def.id}`;
    text.append(label);
    if (def.hint) text.append(el("span", "set-hint", def.hint));
    control.setAttribute("aria-labelledby", label.id);
    r.append(text, control);
    return r;
  }

  function toggle(def: Extract<SettingDef, { type: "boolean" }>): HTMLElement {
    const b = el("button", "switch");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.append(el("span", "knob"));
    let on = def.default;
    b.onclick = () => deps.change(def.id as SettingId, !on);
    updaters.set(def.id, (s) => {
      on = s[def.id as SettingId] as boolean;
      b.setAttribute("aria-checked", String(on));
      b.disabled = NEEDS_TRANSLUCENT.has(def.id) && !s.acrylic;
    });
    return b;
  }

  function segmented(def: Extract<SettingDef, { type: "choice" | "color" }>): HTMLElement {
    const swatches = def.type === "color";
    const group = el("div", swatches ? "swatches" : "segmented");
    group.setAttribute("role", "radiogroup");
    const buttons = def.choices.map((c) => {
      const b = el("button", swatches ? "swatch" : "seg");
      b.type = "button";
      b.setAttribute("role", "radio");
      if (swatches) {
        b.style.setProperty("--swatch", String(c.value));
        b.title = c.label;
        b.setAttribute("aria-label", c.label);
      } else {
        b.textContent = c.label;
      }
      b.onclick = () => deps.change(def.id as SettingId, c.value);
      group.append(b);
      return b;
    });
    // Left/Right move the choice, like a native radio group.
    group.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const at = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
      const next = Math.min(def.choices.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)));
      deps.change(def.id as SettingId, def.choices[next]!.value);
      buttons[next]!.focus();
    });
    updaters.set(def.id, (s) => {
      const v = s[def.id as SettingId];
      const disabled = NEEDS_TRANSLUCENT.has(def.id) && !s.acrylic;
      buttons.forEach((b, i) => {
        const on = def.choices[i]!.value === v;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
        b.disabled = disabled;
      });
    });
    return group;
  }

  function slider(def: Extract<SettingDef, { type: "range" }>): HTMLElement {
    const wrap = el("div", "slider");
    const input = el("input");
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    const out = el("output", "slider-value");
    input.addEventListener("input", () => {
      out.textContent = input.value;
      deps.change(def.id as SettingId, Number(input.value), { debounce: true });
    });
    updaters.set(def.id, (s) => {
      const v = String(s[def.id as SettingId]);
      if (input.value !== v && document.activeElement !== input) input.value = v;
      if (document.activeElement !== input) out.textContent = v;
      input.disabled = NEEDS_TRANSLUCENT.has(def.id) && !s.acrylic;
    });
    wrap.append(input, out);
    return wrap;
  }

  function control(def: SettingDef): HTMLElement {
    if (def.type === "boolean") return toggle(def);
    if (def.type === "range") return slider(def);
    return segmented(def);
  }

  return {
    /** Builds the panel from the schema; `current` fills the controls. */
    build(model: SettingsModel, current: Settings): void {
      updaters.clear();
      const head = el("div", "panel-head");
      head.append(el("h2", "panel-title", "Settings"), closeButton(() => deps.close()));
      const body = el("div", "panel-body");
      for (const g of model.schema.groups) {
        if (g.shellOnly && !deps.inShell) continue; // the Chromium window hides what needs the shell
        const defs = model.schema.settings.filter((d) => d.group === g.id);
        if (defs.length === 0) continue;
        const section = el("section", "set-group");
        section.append(el("h3", "set-group-title", g.label));
        for (const def of defs) section.append(row(def, control(def)));
        body.append(section);
      }
      const about = el("section", "set-group about");
      about.append(el("h3", "set-group-title", "About"));
      const fact = (k: string, v: string) => {
        const r = el("div", "about-row");
        const value = el("span", "about-value", v);
        value.title = v;
        r.append(el("span", "about-key", k), value);
        about.append(r);
      };
      fact("Version", model.about.version || "unknown");
      fact("State directory", model.about.stateDir || "none (settings are not saved)");
      fact("Window", deps.inShell ? "Native shell" : "Browser app window");
      body.append(about);
      const foot = el("div", "panel-foot");
      const keys = el("button", "link-btn", "Keyboard shortcuts");
      keys.type = "button";
      keys.title = deps.shortcutsTip;
      keys.onclick = () => deps.openShortcuts();
      const reset = el("button", "link-btn", "Reset to defaults");
      reset.type = "button";
      reset.onclick = () => deps.reset();
      foot.append(keys, reset);
      deps.root.replaceChildren(head, body, foot);
      firstFocus = body.querySelector<HTMLElement>("button, input");
      this.update(current);
    },
    update(s: Settings): void {
      for (const fn of updaters.values()) fn(s);
    },
    focusFirst(): void {
      (firstFocus ?? deps.root).focus({ preventScroll: true });
    },
  };
}

function chips(keys: string[]): HTMLElement {
  const wrap = el("span", "key-chips");
  keys.forEach((k, i) => {
    if (i > 0) wrap.append(el("span", "key-or", "or"));
    wrap.append(el("kbd", "key-chip", k));
  });
  return wrap;
}

function cheatRow(r: CheatRow): HTMLElement {
  const li = el("li", "cheat-row");
  li.append(chips(r.keys), el("span", "cheat-label", r.label));
  if (r.herdr) li.append(el("span", "cheat-tag", "herdr key"));
  return li;
}

/** Fills the cheat sheet panel. */
export function renderCheatSheet(root: HTMLElement, sheet: CheatSheet, close: () => void): void {
  const head = el("div", "panel-head");
  head.append(el("h2", "panel-title", "Keyboard shortcuts"), closeButton(close));
  const body = el("div", "panel-body");
  if (sheet.top.length) {
    const top = el("ul", "cheat-list cheat-top");
    for (const r of sheet.top) top.append(cheatRow(r));
    body.append(top);
  }
  for (const g of sheet.groups) {
    const section = el("section", "set-group");
    section.append(el("h3", "set-group-title", g.group));
    const list = el("ul", "cheat-list");
    for (const r of g.rows) list.append(cheatRow(r));
    section.append(list);
    body.append(section);
  }
  root.replaceChildren(head, body);
}
