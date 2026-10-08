/**
 * The conversation's history in blocks, the pure part: which tail blocks a refresh touches (keyed by exchange id),
 * where the scroll goes after older blocks are prepended, and the loader that fetches older blocks with its guards
 * (one load at a time, a pane switch or a newer reset drops the answer, an error waits for a retry, a replaced
 * session file goes back to the tail). No DOM: ui/conversation-view.ts and ui/app.ts do that.
 */
import type { Block, Exchange } from "../src/transcript/parse";

/** Older blocks load when the reader scrolls closer than this to the top. */
export const NEAR_TOP_PX = 240;

/** A string that changes whenever the block's rendering would (an image by its length: the data is large). */
export function blockSig(b: Block): string {
  if (b.kind === "text") return `t${b.text.length}:${b.text}`;
  if (b.kind === "image") return `i${b.dataUrl.length}:${b.dataUrl.slice(0, 64)}${b.dataUrl.slice(-64)}`;
  return `c${b.count}:${JSON.stringify(b.items)}`;
}

export const blockSigs = (blocks: Block[]): string[] => blocks.map(blockSig);

/** The tail exchanges a refresh renders, against the exchange ids in the window (oldest first). */
export interface TailPlan {
  /** Throw everything away and render the tail alone: a new session file, or no overlap (a gap could hide in between). */
  reset: boolean;
  /** Ids in the window, after the tail's first one, that the tail no longer has. */
  remove: string[];
}

export function planTail(windowIds: readonly string[], tailIds: readonly string[], sameEpoch: boolean): TailPlan {
  if (windowIds.length === 0) return { reset: false, remove: [] };
  if (!sameEpoch) return { reset: true, remove: [] };
  if (tailIds.length === 0) return { reset: true, remove: [] };
  const inTail = new Set(tailIds);
  const firstShared = windowIds.findIndex((id) => inTail.has(id));
  // No exchange in common: more than a tail's worth arrived since the last refresh (or the file changed).
  if (firstShared < 0) return { reset: true, remove: [] };
  return { reset: false, remove: windowIds.slice(firstShared).filter((id) => !inTail.has(id)) };
}

/** The scrollTop that keeps an anchor element where it was after content was inserted above it. */
export function anchoredScrollTop(scrollTop: number, anchorTopBefore: number, anchorTopAfter: number): number {
  return Math.max(0, scrollTop + (anchorTopAfter - anchorTopBefore));
}

/**
 * The anchor for a prepend: the first element whose bottom is below the top of the view (the first one the reader
 * sees). `tops`/`bottoms` are viewport coordinates of the exchange blocks in order; -1 when there are none.
 */
export function pickAnchor(bottoms: readonly number[], viewTop: number): number {
  for (let i = 0; i < bottoms.length; i++) if (bottoms[i]! > viewTop) return i;
  return bottoms.length - 1;
}

export interface OlderPage {
  exchanges: Exchange[];
  hasMore: boolean;
  oldestId: string | null;
  epoch: number | null;
  /** No more because the server's index stops there (20,000 exchanges), not because the session starts there. */
  truncated?: boolean;
}

/** The top row of the conversation: what it says. */
export type TopState = "hidden" | "more" | "loading" | "error" | "start" | "truncated";

export interface LoaderDeps {
  /** GET the block before `before`; throws an Error with `status`/`code` when the server refuses. */
  fetchOlder(before: string, n: number, context: string): Promise<OlderPage>;
  /** The pane the window shows now: an answer for another pane is dropped. */
  context(): string;
  /** Prepend these exchanges (already known to belong here). */
  apply(page: OlderPage): void;
  /** The session file was replaced or the id is gone: back to the tail. */
  reset(): void;
  /** Show this error (a notice); the top row offers a retry. */
  failed(message: string): void;
  /** The state changed: draw the top row again. */
  changed(state: TopState): void;
}

export function createOlderLoader(deps: LoaderDeps) {
  let hasMore = false;
  let oldestId: string | null = null;
  let epoch: number | null = null;
  let loading = false;
  let error = false;
  let loadedOlder = false;
  let empty = true;
  let truncated = false;
  let gen = 0;

  const state = (): TopState => (empty ? "hidden" : loading ? "loading" : error ? "error" : hasMore ? "more" : truncated ? "truncated" : "start");
  const notify = () => deps.changed(state());

  return {
    state,
    hasMore: () => hasMore,
    loading: () => loading,
    /** A load failed and waits for Retry (nothing loads until then). */
    failed: () => error,
    loadedOlder: () => loadedOlder,
    epoch: () => epoch,

    /** A tail render: until an older block is loaded, the tail says whether there is more (and from where). */
    fromTail(page: { hasMore: boolean; oldestId: string | null; epoch: number | null; truncated?: boolean }, windowOldest: string | null): void {
      if (page.epoch !== epoch) {
        gen++; // an answer for the old file must not land
        loading = false;
        error = false;
        loadedOlder = false;
      }
      epoch = page.epoch;
      empty = windowOldest === null;
      if (!loadedOlder) {
        hasMore = page.hasMore;
        truncated = page.truncated === true;
        oldestId = windowOldest ?? page.oldestId;
      } else oldestId = windowOldest ?? oldestId;
      notify();
    },

    /** A pane switch or a reset to the tail: everything forgotten, any answer in flight dropped. */
    reset(): void {
      gen++;
      hasMore = false;
      truncated = false;
      oldestId = null;
      epoch = null;
      loading = false;
      error = false;
      loadedOlder = false;
      empty = true;
      notify();
    },

    /** Whether a scroll position this close to the top should load the next older block now. */
    wants(scrollTop: number): boolean {
      return scrollTop <= NEAR_TOP_PX && hasMore && !loading && !error && oldestId !== null;
    },

    /** Loads the next older block. `retry` (the button) also clears an error. Resolves when done or dropped. */
    async load(n: number, opts: { retry?: boolean } = {}): Promise<"loaded" | "skipped" | "dropped" | "failed" | "reset"> {
      if (opts.retry) error = false;
      if (loading || error || !hasMore || oldestId === null) return "skipped";
      loading = true;
      const token = ++gen;
      const context = deps.context();
      const before = oldestId;
      notify();
      const stale = () => token !== gen || context !== deps.context();
      try {
        const page = await deps.fetchOlder(before, n, context);
        if (stale()) return "dropped";
        if (page.epoch !== epoch) {
          loading = false;
          deps.reset();
          return "reset";
        }
        loading = false;
        loadedOlder = true;
        hasMore = page.hasMore && page.exchanges.length > 0;
        truncated = page.truncated === true;
        if (page.exchanges.length > 0) oldestId = page.exchanges[0]!.id;
        deps.apply(page);
        notify();
        return "loaded";
      } catch (e) {
        if (stale()) return "dropped";
        loading = false;
        const err = e as { status?: number; code?: string; message?: string };
        if (err.status === 404 && err.code === "unknown-exchange") {
          deps.reset();
          return "reset";
        }
        error = true;
        deps.failed(err.message || "Could not load earlier messages.");
        notify();
        return "failed";
      }
    },

    /** The id the next block ends before (the window's oldest exchange). */
    oldestId: () => oldestId,
  };
}

export type OlderLoader = ReturnType<typeof createOlderLoader>;
