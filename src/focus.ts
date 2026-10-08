/**
 * The pane herdr has in focus, for windows that follow it (setting followFocus). The server polls
 * `herdr pane current` while a window is open and the setting is not off, and pushes a named SSE event `focus`
 * when the focused pane changes. Pure: no node: imports (the window bundles the event type), timers injected.
 */
import type { CurrentPane } from "./herdr";

/** What a window gets in a `focus` event. */
export interface FocusEvent {
  paneId: string;
  /** herdr's agent name ("claude", "codex", ...), null for a plain terminal pane. */
  agent: string | null;
  isClaude: boolean;
  title: string;
  /** The workspace label (the id when herdr has none). */
  workspace: string;
  /** The pane runs on another machine: there is no transcript here to show. */
  remote: boolean;
  /** For a Claude pane of this machine: whether its transcript was found (a brand-new session may not have one yet). */
  transcript?: boolean;
  /** The other machine's label, when herdr names it. */
  machine?: string;
}

/** A cwd written for the other OS family (a POSIX path seen on Windows, a drive path seen elsewhere) is not local. */
export function isForeignCwd(cwd: string, platform: string): boolean {
  if (!cwd) return false;
  if (platform === "win32") return cwd.startsWith("/") && !cwd.startsWith("//");
  return /^[A-Za-z]:[\\/]/.test(cwd);
}

export interface ClassifyDeps {
  platform: string;
  /** workspace id -> label. */
  labels: ReadonlyMap<string, string>;
  /** This machine's label (the header's): a pane naming the same machine is local. */
  localMachine?: string;
  /** Whether a transcript exists for this session and cwd (findTranscript). Only asked for a local Claude pane. */
  hasTranscript(sessionId: string, cwd: string): boolean;
}

/** The event for a focused pane. */
export function focusEventOf(p: CurrentPane, deps: ClassifyDeps): FocusEvent {
  const isClaude = p.agent === "claude";
  const otherMachine = p.machine !== undefined && p.machine !== "" && p.machine !== deps.localMachine;
  const remote = otherMachine || isForeignCwd(p.cwd, deps.platform);
  let transcript: boolean | undefined;
  if (isClaude && !remote) {
    try {
      transcript = p.sessionId ? deps.hasTranscript(p.sessionId, p.cwd) : false;
    } catch {
      transcript = false;
    }
  }
  return {
    paneId: p.paneId,
    agent: p.agent,
    isClaude,
    title: p.title,
    workspace: deps.labels.get(p.workspaceId) ?? p.workspaceId,
    remote,
    ...(transcript !== undefined ? { transcript } : {}),
    ...(otherMachine ? { machine: p.machine } : {}),
  };
}

/** The SSE chunk of a focus event. */
export const focusChunk = (e: FocusEvent): string => `event: focus\ndata: ${JSON.stringify(e)}\n\n`;

export interface PollerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const FOCUS_POLL_MS = 700;
export const FOCUS_MAX_BACKOFF_MS = 5000;
/** A read that has not answered in this time counts as a failure (herdr accepted the call and hangs). */
export const FOCUS_READ_TIMEOUT_MS = 3000;

/** The wait before the next poll after `failures` errors in a row: the interval, doubled per error, at most the cap. */
export function focusDelay(failures: number, intervalMs = FOCUS_POLL_MS, maxMs = FOCUS_MAX_BACKOFF_MS): number {
  if (failures <= 0) return intervalMs;
  return Math.min(maxMs, intervalMs * 2 ** Math.min(failures, 16));
}

export interface FocusPollerDeps {
  /** One `herdr pane current`. */
  read(): Promise<CurrentPane>;
  /** Whether to poll at all: a window is open and the setting is not off. Asked before every poll. */
  active(): boolean;
  /** The focused pane changed (or polling started again): build and push the event. */
  changed(pane: CurrentPane): void | Promise<void>;
  /** What counts as a change (default: the pane id and whether it is a Claude pane). */
  key?(pane: CurrentPane): string;
  /** Polling stopped (nothing open, or the setting is off): what was seen is forgotten. */
  idle?(): void;
  intervalMs?: number;
  /** How long one read may take before it counts as a failure (the read itself should also give up and clean up). */
  readTimeoutMs?: number;
  maxBackoffMs?: number;
  timers?: PollerTimers;
}

const realTimers: PollerTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) };

/** What a change is keyed on: the pane, and whether it is a Claude pane (starting claude in the focused pane counts). */
export const keyOf = (p: CurrentPane): string => `${p.paneId}|${p.agent === "claude" ? "c" : "-"}`;

/**
 * Polls the focused pane: one read at a time (the next poll is scheduled only when the previous one is done), every
 * intervalMs, backing off on errors up to maxBackoffMs. Stops by itself when it is no longer active and forgets what it
 * saw, so polling that starts again reports the focus afresh; wake() starts it.
 */
export function createFocusPoller(deps: FocusPollerDeps) {
  const timers = deps.timers ?? realTimers;
  const interval = deps.intervalMs ?? FOCUS_POLL_MS;
  const maxBackoff = deps.maxBackoffMs ?? FOCUS_MAX_BACKOFF_MS;
  const readTimeout = deps.readTimeoutMs ?? FOCUS_READ_TIMEOUT_MS + 1000;
  /** A step of a poll, or a rejection once it has taken readTimeout: a hung herdr call can never stop the loop. */
  const timed = <T>(work: () => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const h = timers.set(() => reject(new Error("the focus poll timed out")), readTimeout);
      Promise.resolve()
        .then(work)
        .then(
          (p) => {
            timers.clear(h);
            resolve(p);
          },
          (e) => {
            timers.clear(h);
            reject(e);
          },
        );
    });
  let handle: unknown = null;
  let inFlight = false;
  let failures = 0;
  let lastKey: string | null = null;
  let reads = 0;
  // Set by stop(): a read still in flight then neither pushes nor schedules another poll, and wake() is ignored.
  let stopped = false;

  const reset = () => {
    lastKey = null;
    failures = 0;
    deps.idle?.();
  };

  const schedule = (ms: number) => {
    if (handle === null && !stopped) handle = timers.set(() => void tick(), ms);
  };

  async function tick(): Promise<void> {
    handle = null;
    if (inFlight || stopped) return;
    if (!deps.active()) return reset();
    inFlight = true;
    try {
      reads++;
      const pane = await timed(() => deps.read());
      failures = 0;
      const key = (deps.key ?? keyOf)(pane);
      if (key !== lastKey && deps.active() && !stopped) {
        try {
          await timed(() => deps.changed(pane));
          lastKey = key; // only a push that went out counts as reported
        } catch {
          lastKey = null; // a failed or timed-out push is tried again at the next poll, same pane or not
        }
      }
    } catch {
      failures++;
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (deps.active()) schedule(focusDelay(failures, interval, maxBackoff));
    else reset();
  }

  return {
    /** Starts polling now if it is not already running (a window arrived, the setting was turned on). */
    wake(opts: { soon?: boolean } = {}): void {
      if (stopped) return;
      // A window that just arrived does not wait out an error backoff (up to 5 s) for its first event.
      if (opts.soon && handle !== null && failures > 0 && !inFlight) {
        timers.clear(handle);
        handle = null;
      }
      if (handle !== null || inFlight) return;
      if (!deps.active()) return reset();
      schedule(0);
    },
    /** Stops polling for good (the server is shutting down), including after a read that is still in flight. */
    stop(): void {
      stopped = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
      reset();
    },
    running: (): boolean => handle !== null || inFlight,
    failures: (): number => failures,
    reads: (): number => reads,
  };
}
