export type NotifyKind = "finished" | "needs-you";

/**
 * Whether a status change deserves a system notification. Only when the window is in the background and the user
 * allowed it. `notifyOnFinish` (the setting) turns off the "finished" one; "needs you" always notifies.
 */
export function shouldNotify(prev: string | null, next: string, hasFocus: boolean, permission: string, notifyOnFinish = true): NotifyKind | null {
  if (hasFocus || permission !== "granted") return null;
  if (prev === "working" && (next === "done" || next === "idle")) return notifyOnFinish ? "finished" : null;
  if (next === "blocked" && prev !== "blocked") return "needs-you";
  return null;
}

export function notificationTitle(kind: NotifyKind): string {
  return kind === "finished" ? "Claude finished" : "Claude needs you";
}

/** The status the window showed last time; reset when another pane is chosen, so switching never counts as a change. */
export function createStatusWatch() {
  let prev: string | null = null;
  return {
    /** Records the new status and returns the one before it. */
    next(status: string): string | null {
      const before = prev;
      prev = status;
      return before;
    },
    reset(): void {
      prev = null;
    },
  };
}
