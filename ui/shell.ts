import { realTimers, type TimerApi } from "./timers";

/**
 * The page inside the native Sidecr shell (Tauri 2, shell/) versus the Chromium app window.
 *
 * In the shell `window.close()` does nothing: the window is closed through the Tauri window API, which the shell's
 * capability grants to the loopback page only (close, destroy, start-dragging, minimize, and listening to events).
 * The shell turns an OS close (Alt+F4, the taskbar) into the CLOSE_REQUESTED_EVENT; the page runs its unload steps
 * and destroys the window itself, and the shell destroys it after 1.5 s if the page never answers.
 */

/** The part of `window.__TAURI__.window.getCurrentWindow()` the page uses. */
export interface TauriWindowLike {
  destroy(): Promise<void>;
  close(): Promise<void>;
  minimize(): Promise<void>;
}

export interface TauriLike {
  window: { getCurrentWindow: () => TauriWindowLike };
  event?: { listen?: (event: string, handler: (e: unknown) => void) => Promise<() => void> };
  /** App commands (the shell has one: open_lightbox). */
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

/** Emitted by the shell when the OS asks the window to close. Must match CLOSE_REQUESTED_EVENT in shell/src-tauri/src/main.rs. */
export const CLOSE_REQUESTED_EVENT = "sidecr:close-requested";
/** How long the shell waits for the unload requests (draft, bounds, bye) before destroying the window. */
export const SETTLE_MS = 1000;

/** `__TAURI__` with the window API, or null (the Chromium window, or a shell page without the global API). */
export function tauriOf(g: unknown): TauriLike | null {
  const t = (g as { __TAURI__?: unknown } | null | undefined)?.__TAURI__ as Partial<TauriLike> | undefined;
  return t && typeof t === "object" && typeof t.window?.getCurrentWindow === "function" ? (t as TauriLike) : null;
}

export function isShell(g: unknown = globalThis): boolean {
  return tauriOf(g) !== null;
}

/** The current Tauri window, or null outside the shell (or when the API throws). */
export function currentWindow(g: unknown = globalThis): TauriWindowLike | null {
  try {
    return tauriOf(g)?.window.getCurrentWindow() ?? null;
  } catch {
    return null;
  }
}

/**
 * Requests the page starts while it goes away (the draft write, the bounds report, the bye), so the shell can let
 * them finish before it destroys the window: destroying it ends the process and with it the WebView2 network stack,
 * which can drop a request that is still in flight (a lost bye is the 9 s ghost: the next open key press closes a
 * window that is not there).
 */
export function createInFlight(timers: TimerApi = realTimers) {
  const pending = new Set<Promise<void>>();
  return {
    track<T>(p: Promise<T>): Promise<T> {
      const entry: Promise<void> = p.then(
        () => {},
        () => {},
      );
      pending.add(entry);
      void entry.then(() => pending.delete(entry));
      return p;
    },
    /** Resolves when every tracked request has finished, or after `ms`, whichever comes first. Never rejects. */
    settled(ms: number): Promise<void> {
      if (pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          timers.clear(handle);
          resolve();
        };
        const handle = timers.set(finish, ms);
        void Promise.all([...pending]).then(finish);
      });
    },
    size: (): number => pending.size,
  };
}

export interface CloserDeps {
  /** The unload runner (draft, bounds, bye last). It runs its steps once per page life. */
  unload(): void;
  /** The Tauri window in the shell, null in the Chromium window. */
  win: TauriWindowLike | null;
  /** In the shell: resolves when the unload requests are done (or gave up). */
  settle?(): Promise<unknown>;
  /** Closes the Chromium window; defaults to `window.close()`. The only direct window.close() in ui/ is here. */
  closeBrowser?(): void;
}

const browserClose = (): void => window.close();

/**
 * closeWindow for every close path (the server's close push, Alt+S in the window, the ping's close answer, the
 * shell's close request, the header's close button). Runs the unload steps once, then:
 * - Chromium: `window.close()` (the beforeunload that follows finds the runner already done);
 * - shell: waits for the unload requests, then destroys the window. A destroy that is refused falls back to
 *   `close()`, which the shell turns into its close request and destroys after its own timeout.
 * In the shell the first call wins; later calls (two close paths at once) do nothing.
 */
export function createCloser(deps: CloserDeps) {
  let closing = false;
  return {
    close(): void {
      try {
        deps.unload();
      } catch {
        /* the runner already swallows step errors; nothing else can be done here */
      }
      const win = deps.win;
      if (!win) {
        (deps.closeBrowser ?? browserClose)();
        return;
      }
      if (closing) return;
      closing = true;
      void Promise.resolve()
        .then(() => deps.settle?.())
        .catch(() => {})
        .then(() => win.destroy())
        .catch(() => win.close().catch(() => {}));
    },
    closing: (): boolean => closing,
  };
}

/** Subscribes to the shell's close request. Resolves to false when the event API is missing or refuses. */
export async function onCloseRequested(t: TauriLike | null, handler: () => void): Promise<boolean> {
  const listen = t?.event?.listen;
  if (typeof listen !== "function") return false;
  try {
    await listen(CLOSE_REQUESTED_EVENT, () => handler());
    return true;
  } catch {
    return false;
  }
}
