import { realTimers, type TimerApi } from "./timers";

export const INFO_NOTICE_MS = 5000;
export const ERROR_NOTICE_MS = 8000;

/**
 * "info" and "error" go away by themselves (5 s and 8 s); "sticky" is a state of the pane
 * (no session, disconnected) that stays until something replaces it or the conversation refreshes.
 */
export type NoticeKind = "info" | "error" | "sticky";

export interface NoticesDeps {
  /** Puts the text in the notice bar, or hides the bar for null. */
  render(text: string | null): void;
  timers?: TimerApi;
  now?: () => number;
}

/** The bottom notice: one at a time, a newer one replaces the older and restarts the timer, hovering pauses it. */
export function createNotices(deps: NoticesDeps) {
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  let base: string | null = null; // the sticky notice, shown again when a timed one ends
  let current: string | null = null;
  let timed = false;
  let handle: unknown = null;
  let deadline = 0;
  let paused: number | null = null; // ms left, while the pointer is over the notice

  const stop = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    paused = null;
  };
  const arm = (ms: number) => {
    deadline = now() + ms;
    handle = timers.set(() => {
      handle = null;
      dismiss();
    }, ms);
  };
  const show = (text: string | null) => {
    current = text;
    deps.render(text);
  };
  function dismiss(): void {
    if (!timed) return; // a sticky notice is a state, not a message
    stop();
    timed = false;
    show(base);
  }

  return {
    show(text: string, kind: NoticeKind): void {
      if (kind === "sticky") {
        base = text;
        if (timed) return; // a message is on screen: the state shows when it ends
        show(text);
        return;
      }
      stop();
      timed = true;
      arm(kind === "error" ? ERROR_NOTICE_MS : INFO_NOTICE_MS);
      show(text);
    },
    /** The pane's state is fine again: removes the sticky notice, but leaves a message that is still timing out. */
    clearState(): void {
      base = null;
      if (!timed) show(null);
    },
    /** Removes everything, the sticky notice too. */
    clear(): void {
      stop();
      base = null;
      timed = false;
      show(null);
    },
    dismiss,
    /** True while a timed notice is on screen: Esc or a click can remove it. */
    dismissible: (): boolean => timed && current !== null,
    pause(): void {
      if (!timed || handle === null) return;
      paused = Math.max(0, deadline - now());
      timers.clear(handle);
      handle = null;
    },
    resume(): void {
      if (!timed || paused === null) return;
      const left = paused;
      paused = null;
      arm(left);
    },
  };
}
