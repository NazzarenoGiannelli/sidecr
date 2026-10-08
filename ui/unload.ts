/**
 * What the page does as it goes away, once per page life, in the given order (the last step is the bye: after it the
 * server forgets the window). Wire `run` to both `beforeunload` and `pagehide`: in a Chromium app window
 * `window.close()` fires only `beforeunload`, while a reload or a normal navigation fires both. Each step must hand
 * its data to something that outlives the page (`keepalive` fetch, `sendBeacon`). A step that throws does not stop
 * the next. A page restored from the back/forward cache calls `rearm`.
 */
export function createUnloadRunner(steps: Array<() => void>) {
  let done = false;
  return {
    run(): void {
      if (done) return;
      done = true;
      for (const step of steps) {
        try {
          step();
        } catch {
          /* the page is going away: nothing to report to */
        }
      }
    },
    rearm(): void {
      done = false;
    },
  };
}
