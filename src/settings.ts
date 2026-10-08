import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, type SaveDeps } from "./atomic-file";
import { applyPatch, defaultSettings, validateSettings, type Settings } from "./settings-schema";

export * from "./settings-schema";

/** settings.json in the plugin state directory (HERDR_PLUGIN_STATE_DIR, or ~/.config/sidecr). */
export const SETTINGS_FILE = "settings.json";

/** The saved settings. A missing or corrupt file gives the defaults; unknown keys are dropped and an invalid value is replaced by its default. Never throws. */
export function readSettings(dir: string): Settings {
  try {
    return validateSettings(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")));
  } catch {
    return defaultSettings();
  }
}

/** Writes a full set atomically (temp file and rename, retried on Windows sharing errors). */
export function writeSettings(dir: string, settings: Settings, deps: SaveDeps = {}): void {
  writeFileAtomic(dir, SETTINGS_FILE, JSON.stringify(validateSettings(settings), null, 2), deps);
}

/** The file's modification time, or -1 when it is missing or cannot be read. */
function mtimeOf(dir: string): number {
  try {
    return statSync(join(dir, SETTINGS_FILE)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * The store the server keeps: every update is validated per key against the current set and written to disk (when
 * there is a state directory; without one they live in memory only). The file is read again whenever its
 * modification time changes, so a hand edit counts from the next request even while the server keeps running.
 */
export function createSettingsStore(dir: string | undefined, deps: SaveDeps = {}) {
  let seen = dir ? mtimeOf(dir) : -1;
  let current: Settings = dir ? readSettings(dir) : defaultSettings();
  const fresh = (): Settings => {
    if (dir) {
      const m = mtimeOf(dir);
      if (m !== seen) {
        seen = m;
        current = readSettings(dir);
      }
    }
    return current;
  };
  return {
    get: (): Settings => ({ ...fresh() }),
    /** Applies a partial update. Nothing is written when no key was valid or nothing changed. */
    update(patch: unknown): { settings: Settings; rejected: string[]; changed: boolean } {
      const base = fresh();
      const { settings, rejected } = applyPatch(base, patch);
      const changed = JSON.stringify(settings) !== JSON.stringify(base);
      if (changed && dir) {
        writeSettings(dir, settings, deps);
        seen = mtimeOf(dir);
      }
      current = settings;
      return { settings: { ...settings }, rejected, changed };
    },
  };
}
