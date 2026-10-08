import { realTimers, type TimerApi } from "./timers";

/**
 * Runs fn with the latest arguments once calls have stopped for `ms`.
 * flush() runs a pending call right away; cancel() drops it.
 */
export function createDebouncer<A extends unknown[]>(fn: (...args: A) => void, ms: number, timers: TimerApi = realTimers) {
  let handle: unknown = null;
  let pending: A | null = null;
  const fire = () => {
    handle = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  return {
    call(...args: A): void {
      pending = args;
      if (handle !== null) timers.clear(handle);
      handle = timers.set(fire, ms);
    },
    flush(): void {
      if (handle !== null) timers.clear(handle);
      fire();
    },
    cancel(): void {
      if (handle !== null) timers.clear(handle);
      handle = null;
      pending = null;
    },
  };
}
