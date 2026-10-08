/**
 * The window's side of the settings: the current values, applied at once on every change, sent to the server
 * (PUT /api/settings, debounced for the strength slider), and updated from the server's `settings` event.
 * Pure: the network, the clock and what "apply" does are injected.
 */
import { applyPatch, defaultSettings, settingsEqual, type Settings, type SettingId } from "../src/settings-schema";
import { realTimers, type TimerApi } from "./timers";

export interface SettingsClientDeps {
  /**
   * Sends a partial update; resolves to the server's full settings, or null when it failed. `keepalive`: the page
   * is going away, the request must outlive it (and the shell waits for it before destroying the window).
   */
  put(patch: Partial<Settings>, opts?: { keepalive?: boolean }): Promise<Settings | null>;
  /** Makes the page match `next` (CSS, the shell window, the composer). `prev` is what was applied before (null the first time). */
  apply(next: Settings, prev: Settings | null): void;
  /** Called when a save failed; the page shows a notice. */
  failed?(): void;
  timers?: TimerApi;
  /** How long the slider waits before it saves. */
  debounceMs?: number;
}

export const SETTINGS_DEBOUNCE_MS = 300;

export function createSettingsClient(deps: SettingsClientDeps) {
  const timers = deps.timers ?? realTimers;
  const debounceMs = deps.debounceMs ?? SETTINGS_DEBOUNCE_MS;
  let current: Settings = defaultSettings();
  let applied: Settings | null = null;
  // Changes made here that the server has not confirmed yet: queued (waiting for the debounce) or in flight.
  let queued: Partial<Settings> = {};
  let timer: unknown = null;
  let inFlight = 0;

  const show = (next: Settings) => {
    const prev = applied;
    current = next;
    if (prev && settingsEqual(prev, next)) return;
    applied = { ...next };
    deps.apply({ ...next }, prev ? { ...prev } : null);
  };

  const busy = () => timer !== null || inFlight > 0 || Object.keys(queued).length > 0;

  async function send(keepalive = false): Promise<void> {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    const patch = queued;
    queued = {};
    if (Object.keys(patch).length === 0) return;
    inFlight++;
    let result: Settings | null = null;
    try {
      result = await deps.put(patch, keepalive ? { keepalive: true } : undefined);
    } catch {
      result = null;
    } finally {
      inFlight--;
    }
    if (!result) {
      deps.failed?.();
      return;
    }
    // The server's answer is the truth, unless newer local changes are already on their way.
    if (!busy()) show(result);
  }

  return {
    current: (): Settings => ({ ...current }),
    /** True while a local change is waiting or being saved. */
    busy,
    /** The settings from the server's GET (or the cached copy before it answers). Ignored while a local change is pending. */
    load(s: Settings): void {
      if (busy()) return;
      show(s);
    },
    /**
     * A change from the panel: applied now, saved now (or after the debounce, for the slider). Invalid values are
     * dropped here as the server would drop them.
     */
    change(id: SettingId, value: unknown, opts: { debounce?: boolean } = {}): Promise<void> {
      const { settings, rejected } = applyPatch(current, { [id]: value });
      if (rejected.length > 0) return Promise.resolve();
      show(settings);
      queued = { ...queued, [id]: settings[id] };
      if (opts.debounce) {
        if (timer !== null) timers.clear(timer);
        timer = timers.set(() => {
          timer = null;
          void send();
        }, debounceMs);
        return Promise.resolve();
      }
      return send();
    },
    /** Everything back to the schema defaults, in one save. */
    reset(): Promise<void> {
      const d = defaultSettings();
      show(d);
      queued = { ...d };
      return send();
    },
    /**
     * Sends a debounced change right away: when the panel closes, and as an unload step (`keepalive`), so the last
     * slider value is not lost when the window closes within the debounce.
     */
    flush(opts: { keepalive?: boolean } = {}): Promise<void> {
      return timer !== null ? send(opts.keepalive === true) : Promise.resolve();
    },
    /**
     * The server's `settings` event (a change from this window or another). While a change of this window is still
     * pending it is ignored: the pending save produces a newer event, and applying the older one would make the
     * slider jump back.
     */
    pushed(s: Settings): void {
      if (busy()) return;
      show(s);
    },
  };
}
