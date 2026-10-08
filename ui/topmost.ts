/** Ctrl+Shift+T and the header button: always on top flips through the settings like any other change. Pure. */
import type { Settings } from "../src/settings-schema";

/** The short notice after a toggle. */
export const topmostNotice = (on: boolean): string => `Always on top: ${on ? "on" : "off"}`;

/** The new value and what to say about it. */
export function topmostToggle(current: Pick<Settings, "alwaysOnTop">): { value: boolean; notice: string } {
  const value = !current.alwaysOnTop;
  return { value, notice: topmostNotice(value) };
}
