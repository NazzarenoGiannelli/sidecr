/** Decides when an event stream is given up on. Pure, so it can be tested without a browser. */
export type StreamVerdict = "retry" | "disconnected";

export function createConnectionTracker(maxErrorsInARow = 3) {
  let errors = 0;
  return {
    /** Any message proves the stream is alive. */
    message(): void {
      errors = 0;
    },
    /** `closed` is `source.readyState === EventSource.CLOSED`: the browser has stopped retrying on its own. */
    error(closed: boolean): StreamVerdict {
      errors += 1;
      return closed || errors >= maxErrorsInARow ? "disconnected" : "retry";
    },
    reset(): void {
      errors = 0;
    },
  };
}
