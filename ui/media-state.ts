/**
 * The Media & links panel, the pure part: which tab a key selects, the paged list behind each tab (one load at a
 * time, duplicates dropped, a stale cursor starts again from the top, a growing index is asked again), the
 * "Indexing… n%" note, and the plan for "Go to message". No DOM: ui/media-panel.ts and ui/app.ts do that.
 */

export type MediaTab = "images" | "links";
export const MEDIA_TABS: readonly MediaTab[] = ["images", "links"];

export interface MediaImageItem {
  exchangeId: string;
  i: number;
  kind: "block" | "path";
  src: string;
  thumb: string;
  at?: string;
}

export interface MediaLinkItem {
  url: string;
  host: string;
  title?: string;
  count: number;
  exchangeId: string;
  at?: string;
}

export interface MediaResponse<T> {
  items: T[];
  next: string | null;
  progress: number;
  complete: boolean;
  total: number;
}

/** The tab a key press in the panel selects (Left/Right, 1/2), or null. */
export function tabFromKey(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat?: boolean }, current: MediaTab): MediaTab | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === "1") return "images";
  if (e.key === "2") return "links";
  if (e.key === "ArrowLeft") return current === "links" ? "images" : null;
  if (e.key === "ArrowRight") return current === "images" ? "links" : null;
  return null;
}

/** "Indexing… 42%" while older exchanges are still being scanned, else nothing. */
export function indexingNote(r: { progress: number; complete: boolean } | null): string {
  if (!r || r.complete) return "";
  return `Indexing… ${Math.max(0, Math.min(99, Math.floor(r.progress * 100)))}%`;
}

/** The list loads more when the reader is closer than this to its end. */
export const MORE_PX = 200;
/** While the index is still growing, the end of the list is asked again this often. */
export const POLL_MS = 800;

export type ListStatus = "idle" | "loading" | "error" | "empty" | "ready";

export interface ListDeps<T> {
  fetch(cursor: string | null): Promise<MediaResponse<T>>;
  keyOf(item: T): string;
  /** New items (appended), or the status changed. */
  changed(added: T[]): void;
}

export function createMediaList<T>(deps: ListDeps<T>) {
  let items: T[] = [];
  let keys = new Set<string>();
  let next: string | null = null;
  let last: MediaResponse<T> | null = null;
  let loading = false;
  let error: string | null = null;
  let gen = 0;

  const status = (): ListStatus => (loading && !last ? "loading" : error ? "error" : !last ? "idle" : items.length === 0 ? (last.complete ? "empty" : "loading") : "ready");

  async function load(retried = false): Promise<"loaded" | "skipped" | "dropped" | "failed" | "end"> {
    if (loading) return "skipped";
    if (last && last.complete && next === null) return "end";
    loading = true;
    error = null;
    const token = ++gen;
    try {
      const r = await deps.fetch(last ? next : null);
      if (token !== gen) return "dropped";
      loading = false;
      const added: T[] = [];
      for (const it of r.items) {
        const k = deps.keyOf(it);
        if (keys.has(k)) continue;
        keys.add(k);
        items.push(it);
        added.push(it);
      }
      // A page with nothing new while the index grows: keep the cursor we had, the next poll asks from there.
      if (r.next !== null || r.complete) next = r.next;
      last = r;
      deps.changed(added);
      return "loaded";
    } catch (e) {
      if (token !== gen) return "dropped";
      loading = false;
      const err = e as { status?: number; message?: string };
      if (err.status === 410 && !retried) {
        reset();
        return load(true); // the session changed under the cursor: start again from the top
      }
      error = err.message || "Could not load.";
      deps.changed([]);
      return "failed";
    }
  }

  function reset(): void {
    gen++;
    items = [];
    keys = new Set();
    next = null;
    last = null;
    loading = false;
    error = null;
  }

  /** Only the progress (and whether indexing finished), from a fresh first page; the list itself is left alone. */
  async function peek(): Promise<"ok" | "skipped" | "failed"> {
    if (loading || !last) return "skipped";
    const token = gen;
    try {
      const r = await deps.fetch(null);
      if (token !== gen || loading || !last) return "skipped";
      last = { ...last, progress: r.progress, complete: r.complete, total: r.total };
      deps.changed([]);
      return "ok";
    } catch {
      return token === gen ? "failed" : "skipped";
    }
  }

  return {
    load,
    peek,
    reset,
    status,
    items: (): readonly T[] => items,
    error: () => error,
    last: () => last,
    /** Load the next page now: the reader is near the end and there may be more. */
    wantsMore(remainingPx: number): boolean {
      return remainingPx < MORE_PX && !loading && !error && last !== null && (next !== null || !last.complete);
    },
    /** Ask again later: the index is still growing (the note's progress too). */
    growing(): boolean {
      return last !== null && !last.complete && !error;
    },
  };
}

export type MediaList<T> = ReturnType<typeof createMediaList<T>>;

/** Polling for the indexing progress: after a failed peek it waits longer each time, and stops after this many. */
export const POLL_MAX_MS = 8000;
export const POLL_MAX_FAILURES = 5;

/** The wait before the next poll after `failures` failed ones in a row: 800 ms, doubling, at most POLL_MAX_MS. */
export function pollDelay(failures: number): number {
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.max(0, failures));
}

/** "Go to message" loads older blocks until the exchange is in, at most this many exchanges. */
export const JUMP_CAP = 300;
/** However the loads go, a jump takes at most this many steps (a wait for a load in flight counts as one). */
export const MAX_JUMP_STEPS = 400;

export type JumpStep = "found" | "wait" | "load" | "cap" | "missing" | "error" | "stuck";

/**
 * The next step towards an exchange: it is there, wait for a load in flight, load more, or stop: the cap, nothing
 * more to load, a failed load waiting for Retry, or too many steps.
 */
export function planJump(s: { found: boolean; loaded: number; hasMore: boolean; loading: boolean; failed?: boolean; steps?: number }, cap = JUMP_CAP): JumpStep {
  if (s.found) return "found";
  if (s.failed) return "error";
  if ((s.steps ?? 0) >= MAX_JUMP_STEPS) return "stuck";
  if (s.loading) return "wait";
  if (!s.hasMore) return "missing";
  if (s.loaded >= cap) return "cap";
  return "load";
}

export interface JumpDeps {
  found(): boolean;
  /** Exchanges loaded since the jump began. */
  loaded(): number;
  hasMore(): boolean;
  loading(): boolean;
  failed(): boolean;
  load(): Promise<"loaded" | "skipped" | "dropped" | "failed" | "reset">;
  /** Still the same pane. */
  here(): boolean;
  /** Lets a load in flight finish (a real wait: a macrotask, never a microtask loop). */
  wait(): Promise<void>;
}

/** How a jump ended: there, or why it stopped. "left": the pane changed (nothing to say there). */
export type JumpEnd = "found" | "cap" | "missing" | "error" | "changed" | "left" | "stuck";

/** Drives "Go to message" to an end; every path is bounded (MAX_JUMP_STEPS). */
export async function runJump(d: JumpDeps, cap = JUMP_CAP): Promise<JumpEnd> {
  for (let steps = 0; ; steps++) {
    if (!d.here()) return "left";
    const step = planJump({ found: d.found(), loaded: d.loaded(), hasMore: d.hasMore(), loading: d.loading(), failed: d.failed(), steps }, cap);
    if (step === "found" || step === "cap" || step === "missing" || step === "error" || step === "stuck") return step;
    if (step === "wait") {
      await d.wait();
      continue;
    }
    const r = await d.load();
    if (r === "failed") return "error";
    if (r === "reset" || r === "dropped") return d.here() ? "changed" : "left";
    if (r === "skipped" && !d.loading()) {
      if (d.failed()) return "error";
      await d.wait(); // nothing loaded and nothing in flight: the next plan decides (missing or stuck), never a tight loop
    }
  }
}

/** Where a jump puts the exchange: its top a third of the way down the view. */
export function jumpScrollTop(scrollTop: number, targetTop: number, viewTop: number, viewHeight: number): number {
  return Math.max(0, Math.round(scrollTop + (targetTop - viewTop) - viewHeight / 3));
}
