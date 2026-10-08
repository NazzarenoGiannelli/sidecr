export interface ByeSenderDeps {
  /** Sends the bye (a beacon). May throw: the listener must not. */
  send(): void;
}

/**
 * Says bye at most once per page life. It is wired to both `beforeunload` and `pagehide`: in a Chromium app window
 * `window.close()` fires `beforeunload` but not `pagehide`, so `pagehide` alone never delivered the bye and the
 * server kept a closed window in its registry for the whole time to live. It is NOT wired to `visibilitychange`:
 * a minimised window is hidden and has to stay registered.
 */
export function createByeSender(deps: ByeSenderDeps) {
  let sent = false;
  return {
    sendOnce(): void {
      if (sent) return;
      sent = true; // set first: a throwing send is not retried by the second event
      try {
        deps.send();
      } catch {
        /* nothing more can be done while the page is going away */
      }
    },
    /** The page came back from the back/forward cache (`pageshow` with `persisted`): it can say bye again. */
    rearm(): void {
      sent = false;
    },
  };
}
