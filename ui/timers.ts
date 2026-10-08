/** The timer functions the pure modules use, so tests can drive them by hand instead of waiting. */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerApi = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) };
