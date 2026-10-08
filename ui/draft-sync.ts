import { createDebouncer } from "./debounce";
import { realTimers, type TimerApi } from "./timers";

export const DRAFT_DEBOUNCE_MS = 400;

export interface DraftSyncDeps {
  /** GET /api/draft: the stored text for a pane. */
  load(pane: string): Promise<string>;
  /** PUT /api/draft. keepalive is set for writes that must outlive the page (pane switch, pagehide). */
  save(pane: string, text: string, keepalive: boolean): Promise<unknown>;
  timers?: TimerApi;
  debounceMs?: number;
}

/** Keeps the composer text of each pane on the server. Errors are ignored: a lost draft is not worth a message. */
export function createDraftSync(deps: DraftSyncDeps) {
  let keepalive = false;
  let typedCount = 0;
  let pendingPane: string | null = null;

  function write(pane: string, text: string) {
    try {
      void Promise.resolve(deps.save(pane, text, keepalive)).catch(() => {});
    } catch {
      /* ignored */
    }
  }

  const debounced = createDebouncer(
    (pane: string, text: string) => {
      pendingPane = null;
      write(pane, text);
    },
    deps.debounceMs ?? DRAFT_DEBOUNCE_MS,
    deps.timers ?? realTimers,
  );

  return {
    /** The user edited the composer of `pane`. */
    typed(pane: string, text: string): void {
      typedCount += 1;
      pendingPane = pane;
      debounced.call(pane, text);
    },
    /** Saves what is pending right now; for a pane switch or the window closing. */
    flush(): void {
      keepalive = true;
      try {
        debounced.flush();
      } finally {
        keepalive = false;
      }
    },
    /** The message was sent: forget that pane's pending text (not another pane's) and store an empty draft. */
    clear(pane: string): void {
      if (pendingPane === pane) {
        debounced.cancel();
        pendingPane = null;
      }
      write(pane, "");
    },
    /**
     * The stored text to put into the composer of `pane`, or null when it must be left alone:
     * nothing is stored, the load failed, the user typed meanwhile, the composer is not empty, or the pane changed.
     */
    async restore(pane: string, current: () => { pane: string; value: string }): Promise<string | null> {
      const mark = typedCount;
      let text: string;
      try {
        text = await deps.load(pane);
      } catch {
        return null;
      }
      const now = current();
      if (text === "" || typedCount !== mark || now.pane !== pane || now.value !== "") return null;
      return text;
    },
  };
}
