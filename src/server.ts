import { existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { attachmentPathLength, buildMessage, hasWhitespace, saveAttachment } from "./attachments";
import { ESC_KEY, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_CHARS } from "./config";
import { DraftTooLongError, getDraft, setDraft } from "./drafts";
import { DIR_STATUS, resolveDir, resolveOpen, resolveReveal } from "./dirs";
import { ATTACHMENTS_PATH_SPACES, ATTACHMENTS_PATH_SPACES_MESSAGE } from "./send-errors";
import { isAllowedFile, isImagePath, isOpenablePath } from "./files";
import { createFocusPoller, focusChunk, focusEventOf, isForeignCwd, keyOf, type PollerTimers } from "./focus";
import { HerdrError, SidecrError, assertSendable, deliver, type HerdrLike, type PaneInfo } from "./herdr";
import { collectPaths, expandHome } from "./links";
import { createSettingsStore, GROUPS, SCHEMA, type Settings } from "./settings";
import { parseSpinnerLine } from "./spinner";
import { createHistory, type MediaCursor, type MediaImage, type MediaLink, type TranscriptReader } from "./transcript/history";
import { findTranscript } from "./transcript/locate";
import { turnOf, type Exchange } from "./transcript/parse";
import { fsTranscriptReader } from "./transcript/reader";
import { SERVER_API_VERSION } from "./version";
import { validateBounds, writeBounds } from "./window-bounds";
import { createWindowRegistry, isWindowId } from "./windows";

/** What the file manager is asked to do: show a folder, or show a file in its folder (never opening it). */
export type OpenKind = "dir" | "reveal";

export interface ServerOptions {
  herdr: HerdrLike;
  token: string;
  attachmentsDir: string;
  projectsRoot?: string;
  uiDir: string;
  distDir: string;
  /** Hands a URL or a file to the OS default handler; kind "dir" shows a folder, kind "reveal" shows a file in its folder (file manager). */
  opener: (target: string, kind?: OpenKind) => Promise<void>;
  port?: number;
  /** Consecutive failed herdr probes after which an event stream reports "gone" and closes. */
  sseMaxFailures?: number;
  /** How long an event stream reuses the last herdr probe, in ms. */
  sseCacheMs?: number;
  /** Where window.json (the remembered window placement) is written. Without it the endpoint is off. */
  stateDir?: string;
  /** Shown in the window header next to the workspace. */
  machineName?: string;
  /** How long the workspace list is reused, in ms. */
  workspaceCacheMs?: number;
  /** The clock, in ms. Tests inject one; the stop cooldown reads it. */
  now?: () => number;
  /** The plugin version (package.json), shown in the settings panel's About section. */
  version?: string;
  /** How the history index reads transcripts (tests inject one). */
  transcriptReader?: TranscriptReader;
  /** The focus poll interval and its error backoff cap, in ms (tests shorten them). */
  focusPollMs?: number;
  focusMaxBackoffMs?: number;
  /** The focus poller's timers (tests drive them by hand). */
  focusTimers?: PollerTimers;
  /** process.platform unless a test says otherwise: decides which cwd is another machine's. */
  platform?: string;
}

export function isHostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieToken(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "sidecr") return v.join("=");
  }
  return null;
}

/** A POST/PUT from a page on another origin carries Sec-Fetch-Site: cross-site or same-site. No header (curl, tests) passes. */
export function isCrossSite(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

const hasJsonBody = (req: Request): boolean => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface Location {
  pane: PaneInfo;
  file: string | null;
  error?: "no-session" | "transcript-not-found" | "other-machine";
}

interface Conversation extends Location {
  exchanges: Exchange[];
  /** There are older exchanges before the first one (load them with ?before=<oldestId>). */
  hasMore: boolean;
  oldestId: string | null;
  /** The history index's epoch for this transcript: a change means the ids the window holds are stale. */
  epoch: number | null;
  /** Set for a block of older exchanges (?before=): no activity is computed for it. */
  block?: boolean;
  /** No more history because the index reached its 20,000-exchange limit, not because the session starts here. */
  truncated?: boolean;
}

/** The most exchanges one request returns (?n=). */
export const MAX_BLOCK = 50;
const MAX_EXCHANGE_ID_CHARS = 200;

/** ?n=: absent gives the fallback; a number is clamped to 1..MAX_BLOCK; anything else is invalid (null). */
export function blockSize(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d{1,6}$/.test(raw)) return null;
  return Math.min(MAX_BLOCK, Math.max(1, Number(raw)));
}

/** Items per /api/media page: default and most. */
export const MEDIA_PAGE = 40;
export const MAX_MEDIA_PAGE = 100;
const MAX_CURSOR_CHARS = 4096;

/** The opaque cursor of /api/media: base64url JSON of the history index's MediaCursor. */
export function encodeCursor(c: MediaCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

/** The cursor back, or null when it is not one of ours. */
export function decodeCursor(raw: string): MediaCursor | null {
  if (raw.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const int = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (!int(o.e) || !int(o.o) || !int(o.q)) return null;
  if (o.n !== undefined && (typeof o.n !== "string" || o.n.length > MAX_CURSOR_CHARS)) return null;
  return { e: o.e as number, o: o.o as number, q: o.q as number, ...(typeof o.n === "string" ? { n: o.n } : {}) };
}

/** What the window gets for an image: the URL it would use itself (/api/image for a block, /api/file for a path). */
export function mediaImageItem(pane: string, m: MediaImage) {
  const src =
    m.kind === "block"
      ? `/api/image?pane=${encodeURIComponent(pane)}&ex=${encodeURIComponent(m.exchangeId)}&block=u${m.block ?? 0}`
      : `/api/file?pane=${encodeURIComponent(pane)}&path=${encodeURIComponent(m.path ?? "")}`;
  return { exchangeId: m.exchangeId, i: m.kind === "block" ? (m.block ?? 0) : m.seq, kind: m.kind, src, thumb: src, ...(m.at ? { at: m.at } : {}) };
}

/** What the window gets for a link: data only (it is opened through /api/open, never used as an href). */
export function mediaLinkItem(l: MediaLink) {
  return { url: l.url, host: l.host, ...(l.title ? { title: l.title } : {}), count: l.count, exchangeId: l.exchangeId, ...(l.at ? { at: l.at } : {}) };
}

/** An exchange id from the query: 1 to 200 characters, no control characters. */
export const isExchangeId = (v: string | null): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_EXCHANGE_ID_CHARS && !/[\u0000-\u001f\u007f]/.test(v);

/** herdr says "pane w1:p9 not found", or the JSON form with code pane_not_found. "socket not found" is not that. */
const PANE_NOT_FOUND = /\bpane\b[^\n]*not[ _]found|pane_not_found/i;
// A herdr message is short; the cap keeps the scan bounded whatever an odd error carries.
const isPaneNotFound = (message: string): boolean => PANE_NOT_FOUND.test(message.slice(0, 500));

const PATHS_MEMO_MS = 2000;
const MAX_PANE_ID_CHARS = 200;
/** After an Esc is sent to a pane, another stop for it within this time is answered without sending. */
const STOP_COOLDOWN_MS = 1500;

export interface Activity {
  source: "screen" | "transcript";
  verb?: string;
  elapsedSec?: number;
  detail?: string;
  startedAt?: string;
  tokens?: { input: number; output: number };
}

export function createServer(opts: ServerOptions) {
  const stats = { lastRequest: Date.now(), sse: 0 };
  const sseMaxFailures = opts.sseMaxFailures ?? 5;
  const sseCacheMs = opts.sseCacheMs ?? 2000;
  const workspaceCacheMs = opts.workspaceCacheMs ?? 5000;
  const machine = opts.machineName ?? "";
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  // settings.json in the state directory (in memory only without one). Read once; PUT /api/settings updates it.
  const settingsStore = createSettingsStore(opts.stateDir);
  const exchangesShown = (): number => settingsStore.get().exchangesShown;
  // Where each exchange of a transcript begins, kept per session (src/transcript/history.ts): the tail and older blocks.
  const history = createHistory({ reader: opts.transcriptReader ?? fsTranscriptReader });

  // pane id -> when the last Esc was sent. herdr reports "idle" only after its own detection delay, so without this
  // a double click (or two windows, or a retry) would send a second Esc into an idle prompt.
  const lastStop = new Map<string, number>();
  const inCooldown = (pane: string): boolean => {
    const at = lastStop.get(pane);
    return at !== undefined && now() - at < STOP_COOLDOWN_MS;
  };

  // The workspace list is one herdr call; it is reused for a few seconds and shared by concurrent requests.
  // A failing list keeps the previous labels (or none) for the same time, so a request falls back to ids instead of failing.
  let labels: { at: number; map: Map<string, string> } | null = null;
  let labelsInFlight: Promise<Map<string, string>> | null = null;
  async function workspaceLabels(): Promise<Map<string, string>> {
    if (labels && Date.now() - labels.at < workspaceCacheMs) return labels.map;
    labelsInFlight ??= (async () => {
      let map = labels?.map ?? new Map<string, string>(); // on failure keep the last good list
      try {
        map = new Map((await opts.herdr.listWorkspaces()).map((w) => [w.id, w.label]));
      } catch {
        /* herdr could not list workspaces: ids stand in for labels */
      }
      labels = { at: Date.now(), map };
      return map;
    })().finally(() => {
      labelsInFlight = null;
    });
    return labelsInFlight;
  }

  /** Cheap: the pane and its transcript file, nothing parsed. */
  async function locate(paneId: string): Promise<Location> {
    const pane = await opts.herdr.getPane(paneId);
    if (pane.agent !== "claude" || !pane.sessionId) return { pane, file: null, error: "no-session" };
    const file = findTranscript(pane.sessionId, pane.cwd, opts.projectsRoot);
    // A cwd of the other OS family belongs to a pane of another machine: its transcript is not on this disk.
    if (!file) return { pane, file: null, error: isForeignCwd(pane.cwd, platform) ? "other-machine" : "transcript-not-found" };
    return { pane, file };
  }

  /** The tail (the latest n turns), or with `before` the n turns before that exchange. "unknown": no such exchange. */
  async function conversation(paneId: string, req: { before?: string; n?: number } = {}): Promise<Conversation | "unknown"> {
    const loc = await locate(paneId);
    const none: Conversation = { ...loc, exchanges: [], hasMore: false, oldestId: null, epoch: null };
    if (req.before !== undefined) none.block = true;
    if (!loc.file) return none;
    if (req.before !== undefined) {
      const page = await history.before(loc.file, req.before, req.n ?? settingsStore.get().loadBlock);
      if (page === "unknown") return "unknown";
      return page ? { ...loc, ...page, block: true } : none;
    }
    const page = await history.tail(loc.file, req.n ?? exchangesShown());
    return page ? { ...loc, ...page } : none;
  }

  /** What Claude is doing right now: the spinner line from the screen when there is one, else the transcript's numbers. */
  async function activityOf(c: Conversation): Promise<Activity> {
    let spinner: ReturnType<typeof parseSpinnerLine> = null;
    try {
      spinner = parseSpinnerLine(await opts.herdr.readScreen(c.pane.paneId));
    } catch {
      /* the screen could not be read: the transcript still tells how long and how much */
    }
    // A message queued while Claude works joins the running turn: it must not restart the clock or the token total.
    // c is always the tail here (a block of older exchanges never computes activity).
    const turn = turnOf(c.exchanges);
    return {
      source: spinner ? "screen" : "transcript",
      ...(spinner ? { verb: spinner.verb } : {}),
      ...(spinner ? { elapsedSec: spinner.elapsedSec } : {}),
      ...(spinner?.detail ? { detail: spinner.detail } : {}),
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.tokens ? { tokens: turn.tokens } : {}),
    };
  }

  const payload = async (c: Conversation) => {
    // Only a Claude pane has a spinner and a transcript worth showing as activity; the two herdr calls run together.
    const working = !c.block && c.pane.agent === "claude" && c.pane.agentStatus === "working";
    const [names, activity] = await Promise.all([workspaceLabels(), working ? activityOf(c) : Promise.resolve(null)]);
    return {
      pane: {
        id: c.pane.paneId,
        title: c.pane.title,
        status: c.pane.agentStatus,
        agent: c.pane.agent,
        workspace: names.get(c.pane.workspaceId) ?? c.pane.workspaceId,
      },
      machine,
      exchanges: c.exchanges,
      hasMore: c.hasMore,
      oldestId: c.oldestId,
      epoch: c.epoch,
      ...(c.truncated ? { truncated: true } : {}),
      ...(activity ? { activity } : {}),
      ...(c.error ? { error: c.error } : {}),
    };
  };

  // Several thumbnails render at once; each /api/file would otherwise cost a getPane and a transcript parse.
  // An entry is reused while it is under 2 s old and the transcript file is the same size (an unchanged file
  // cannot have new paths in it). Checking the size needs no herdr call.
  // The number of exchanges shown is part of the key: after 3 → 10 the older images must be allowed at once.
  // What is allowed: the paths of every exchange the history index has handed out for this session (the tail and
  // every older block the window loaded; src/transcript/history.ts paths()), never anything else.
  const pathsMemo = new Map<string, { at: number; file: string | null; size: number; shown: number; paths: ReadonlySet<string> }>();

  const sizeOf = (file: string | null): number => {
    try {
      return file ? statSync(file).size : -1;
    } catch {
      return -1;
    }
  };

  async function allowedPaths(paneId: string): Promise<ReadonlySet<string>> {
    const shown = exchangesShown();
    const hit = pathsMemo.get(paneId);
    if (hit && Date.now() - hit.at < PATHS_MEMO_MS && hit.shown === shown && sizeOf(hit.file) === hit.size) return hit.paths;
    const loc = await locate(paneId);
    const size = sizeOf(loc.file); // measured before parsing, so a write during the parse invalidates the entry
    let paths: ReadonlySet<string> = new Set();
    // The tail's paths join the session's set (the window shows the tail even before it asks for the conversation).
    if (loc.file && (await history.tail(loc.file, shown))) paths = history.paths(loc.file);
    const entry = { at: Date.now(), file: loc.file, size, shown, paths };
    pathsMemo.set(paneId, entry);
    return entry.paths;
  }

  // Which Sidecr windows are open, so the open key can close them and there is never more than one.
  const windows = createWindowRegistry();
  // window id -> the senders of its event streams (a window reconnects its stream when it switches pane, so a set).
  const windowStreams = new Map<string, Set<(chunk: string) => void>>();
  // Every open event stream, with or without a window id: a settings change goes to all of them.
  const allStreams = new Set<(chunk: string) => void>();

  /** A named SSE event: pages that do not listen for it (older builds) never see it in their onmessage. */
  function pushSettings(settings: Settings): void {
    const chunk = `event: settings\ndata: ${JSON.stringify(settings)}\n\n`;
    for (const send of allStreams) send(chunk);
  }

  /** A window whose event stream is connected is open whatever its pings say: refresh it before deciding anything. */
  function refreshStreamed(): void {
    const t = now();
    for (const id of windowStreams.keys()) windows.keepAlive(id, t);
  }

  // The pane herdr has in focus (src/focus.ts), for windows that follow it. Polled only while a window is open and
  // followFocus is not off; the last event is kept so a window that (re)connects its stream knows it at once.
  let focusMemo: string | null = null;
  const hasWindows = (): boolean => windowStreams.size > 0 || windows.alive(now()).length > 0;
  const readCurrent = opts.herdr.currentPane?.bind(opts.herdr);
  // Whether a Claude pane's transcript exists, cached: found stays found; not found is looked up again after 3 s (a
  // miss scans every project folder). Part of the focus key, so a new session's file turning up is a change.
  const transcriptSeen = new Map<string, { at: number; found: boolean }>();
  const hasTranscript = (session: string, cwd: string): boolean => {
    const k = `${session}|${cwd}`;
    const hit = transcriptSeen.get(k);
    if (hit && (hit.found || Date.now() - hit.at < 3000)) return hit.found;
    let found: boolean;
    try {
      found = findTranscript(session, cwd, opts.projectsRoot) !== null;
    } catch {
      // The projects folder could not be read (EACCES, a folder removed mid-scan): unknown, keep the last answer
      // and try again next time, rather than failing every poll.
      return hit?.found ?? false;
    }
    if (transcriptSeen.size > 200) transcriptSeen.clear();
    transcriptSeen.set(k, { at: Date.now(), found });
    return found;
  };
  const focusPoller = readCurrent
    ? createFocusPoller({
        read: readCurrent,
        active: () => settingsStore.get().followFocus !== "off" && hasWindows(),
        changed: async (pane) => {
          const ev = focusEventOf(pane, {
            platform,
            labels: await workspaceLabels(),
            localMachine: machine,
            hasTranscript,
          });
          focusMemo = focusChunk(ev);
          for (const set of windowStreams.values()) for (const send of set) send(focusMemo);
        },
        key: (pane) =>
          `${keyOf(pane)}|${pane.agent === "claude" && pane.sessionId && !isForeignCwd(pane.cwd, platform) ? (hasTranscript(pane.sessionId, pane.cwd) ? "t" : "n") : ""}`,
        idle: () => {
          focusMemo = null;
        },
        ...(opts.focusPollMs !== undefined ? { intervalMs: opts.focusPollMs } : {}),
        ...(opts.focusMaxBackoffMs !== undefined ? { maxBackoffMs: opts.focusMaxBackoffMs } : {}),
        ...(opts.focusTimers ? { timers: opts.focusTimers } : {}),
      })
    : null;

  /** Tells these windows to close themselves. A stream that is already gone is skipped; nothing here can throw. */
  function pushClose(ids: string[]): void {
    for (const id of ids) {
      for (const send of windowStreams.get(id) ?? []) send("data: close\n\n");
    }
  }

  /**
   * An event stream. `focusOnly`: a window whose pane is gone keeps a stream for the close push, settings and focus
   * events only (no pane probes), so a later selection in herdr can still move it to another pane.
   */
  function events(paneId: string, windowId: string | null, focusOnly = false): Response {
    let timer: ReturnType<typeof setInterval>;
    let beat: ReturnType<typeof setInterval>;
    // Set by finish(); every write checks it, and a write can never throw out of an interval callback.
    let closed = false;
    let unregister = () => {};
    let sendRef: (chunk: string) => void = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(beat);
      unregister();
      allStreams.delete(sendRef);
      stats.sse--;
    };
    const stream = new ReadableStream({
      start(controller) {
        stats.sse++;
        const enc = new TextEncoder();
        let last = "";
        let cache: { at: number; file: string | null; status: string } = { at: 0, file: null, status: "" };
        let inFlight = false;
        let failures = 0;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            /* the client went away between the check and the write */
          }
        };
        sendRef = send;
        allStreams.add(send);
        if (windowId) {
          let set = windowStreams.get(windowId);
          if (!set) windowStreams.set(windowId, (set = new Set()));
          const mine = set;
          mine.add(send);
          unregister = () => {
            mine.delete(send);
            if (mine.size === 0 && windowStreams.get(windowId) === mine) windowStreams.delete(windowId);
          };
          // A window is here: the focus poller runs (it stops by itself once none is left), and the window learns
          // where herdr's focus is right away instead of at the next change.
          if (focusMemo) send(focusMemo);
          focusPoller?.wake({ soon: true });
        }
        const tick = async () => {
          if (closed || inFlight) return;
          inFlight = true;
          try {
            if (Date.now() - cache.at > sseCacheMs) {
              try {
                const c = await locate(paneId);
                cache = { at: Date.now(), file: c.file, status: `${c.pane.agentStatus}:${c.pane.sessionId}` };
                failures = 0;
              } catch {
                // Back off like a success would: no herdr call every tick while herdr or the pane is unavailable.
                cache = { at: Date.now(), file: null, status: "unavailable" };
                failures++;
              }
              if (closed) return;
              if (failures >= sseMaxFailures) {
                // herdr is unreachable or the pane is gone for good: say so once and stop, so the UI can stop retrying.
                send("data: gone\n\n");
                finish();
                try {
                  controller.close();
                } catch {
                  /* already closed by the client */
                }
                return;
              }
            }
            let size = -1;
            try {
              if (cache.file && existsSync(cache.file)) size = statSync(cache.file).size;
            } catch {
              /* the transcript vanished between the check and the stat */
            }
            const sig = `${size}|${cache.status}`;
            if (sig !== last) {
              last = sig;
              send("data: changed\n\n");
            }
          } finally {
            inFlight = false;
          }
        };
        if (!focusOnly) timer = setInterval(() => void tick(), 500);
        beat = setInterval(() => send(": hb\n\n"), 15000);
        if (!focusOnly) void tick();
      },
      cancel() {
        finish();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req): Promise<Response> {
      stats.lastRequest = Date.now();
      const url = new URL(req.url);
      if (!isHostAllowed(req.headers.get("host"), Number(server.port))) return json({ error: "bad-host" }, 403);
      if (isCrossSite(req)) return json({ error: "cross-site" }, 403);
      if (url.pathname === "/health") return json({ app: "sidecr", pid: process.pid, version: SERVER_API_VERSION });

      const viaCookie = tokenMatches(cookieToken(req.headers.get("cookie")), opts.token);
      const viaQuery = url.pathname === "/" && tokenMatches(url.searchParams.get("t"), opts.token);
      if (!viaCookie && !viaQuery) return json({ error: "unauthorized" }, 401);

      try {
        const paneId = url.searchParams.get("pane") ?? "";
        switch (url.pathname) {
          case "/": {
            const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            if (viaQuery) headers.set("set-cookie", `sidecr=${opts.token}; HttpOnly; SameSite=Strict; Path=/`);
            return new Response(Bun.file(join(opts.uiDir, "index.html")), { headers });
          }
          case "/app.js":
            return new Response(Bun.file(join(opts.distDir, "app.js")), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
          case "/style.css":
            return new Response(Bun.file(join(opts.uiDir, "style.css")), { headers: { "content-type": "text/css", "cache-control": "no-store" } });
          case "/lightbox.html":
            return new Response(Bun.file(join(opts.uiDir, "lightbox.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
          case "/lightbox.js":
            return new Response(Bun.file(join(opts.distDir, "lightbox.js")), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
          case "/favicon.svg":
            return new Response(Bun.file(join(opts.uiDir, "favicon.svg")), { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
          case "/api/panes": {
            const panes = (await opts.herdr.listAgentPanes()).filter((p) => p.agent === "claude");
            const names = await workspaceLabels();
            return json({ panes: panes.map((p) => ({ ...p, workspace: names.get(p.workspaceId) ?? p.workspaceId })) });
          }
          case "/api/conversation": {
            const beforeParam = url.searchParams.get("before");
            if (beforeParam !== null && !isExchangeId(beforeParam)) return json({ error: "bad-request", message: "before is not an exchange id" }, 400);
            const n = blockSize(url.searchParams.get("n"), beforeParam === null ? exchangesShown() : settingsStore.get().loadBlock);
            if (n === null) return json({ error: "bad-request", message: "n is not a number" }, 400);
            const c = await conversation(paneId, { ...(beforeParam !== null ? { before: beforeParam } : {}), n });
            if (c === "unknown") return json({ error: "unknown-exchange", message: "That exchange is not in this session." }, 404);
            return json(await payload(c));
          }
          case "/api/events": {
            const winParam = url.searchParams.get("win");
            if (winParam !== null && !isWindowId(winParam)) return json({ error: "bad-window" }, 400);
            const focusOnly = url.searchParams.get("focus") === "only";
            if (focusOnly && winParam === null) return json({ error: "bad-window" }, 400);
            return events(paneId, winParam, focusOnly);
          }
          case "/api/window": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body = (await req.json().catch(() => null)) as { id?: unknown; event?: unknown } | null;
            const event = body?.event;
            if (!isWindowId(body?.id) || (event !== "hello" && event !== "ping" && event !== "bye")) return json({ error: "bad-body" }, 400);
            const id = body.id;
            refreshStreamed();
            const t = now();
            if (event === "hello") pushClose(windows.hello(id, t)); // the newest window wins
            else if (event === "ping") windows.ping(id, t);
            else windows.bye(id, t);
            if (event !== "bye") focusPoller?.wake({ soon: event === "hello" });
            // A toggle that closed this window while its event stream was gone is delivered here, once.
            return json({ ok: true, close: event === "bye" ? false : windows.takeClose(id) });
          }
          case "/api/toggle": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body = (await req.json().catch(() => null)) as { pane?: unknown } | null;
            if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "bad-body" }, 400);
            if (body.pane !== undefined && (typeof body.pane !== "string" || body.pane.length > MAX_PANE_ID_CHARS)) return json({ error: "bad-body" }, 400);
            refreshStreamed();
            const result = windows.toggle(now());
            if (result.action === "close") pushClose(result.ids);
            return json({ action: result.action });
          }
          case "/api/send": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            const form = await req.formData();
            const pane = String(form.get("pane") ?? "");
            const text = String(form.get("text") ?? "").trim();
            const files = form.getAll("files").filter((f): f is File => f instanceof File);
            if (!pane || (!text && files.length === 0)) return json({ error: "empty" }, 400);
            // An attachment would reach Claude Code as a broken `@path` (it stops at the first space): refuse before saving.
            if (files.length > 0 && hasWhitespace(opts.attachmentsDir)) {
              return json({ error: ATTACHMENTS_PATH_SPACES, message: ATTACHMENTS_PATH_SPACES_MESSAGE }, 422);
            }
            // Size the message before anything is written: an over-long one is refused with no side effects.
            // attachmentPathLength is an upper bound of the saved path, so the real message never exceeds this.
            const planned = text.length + files.reduce((n, f) => n + 2 + attachmentPathLength(opts.attachmentsDir, f.name), 0);
            if (planned > MAX_MESSAGE_CHARS) return json({ error: "too-long", message: "attach long text as a file" }, 413);
            assertSendable(await opts.herdr.getPane(pane), await opts.herdr.readScreen(pane));
            const paths: string[] = [];
            for (const f of files) {
              if (f.size > MAX_ATTACHMENT_BYTES) return json({ error: "too-large", name: f.name }, 413);
              paths.push(saveAttachment(opts.attachmentsDir, f.name, new Uint8Array(await f.arrayBuffer())));
            }
            await deliver(opts.herdr, pane, buildMessage(text, paths));
            return json({ ok: true });
          }
          case "/api/stop": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body = (await req.json().catch(() => null)) as { pane?: unknown } | null;
            const pane = typeof body?.pane === "string" ? body.pane : "";
            if (!pane) return json({ error: "bad-body" }, 400);
            const t = now();
            for (const [id, at] of lastStop) if (t - at >= STOP_COOLDOWN_MS) lastStop.delete(id);
            if (inCooldown(pane)) return json({ ok: true, deduped: true });
            let info: PaneInfo | null = null;
            try {
              info = await opts.herdr.getPane(pane);
            } catch (e) {
              // Only a pane that does not exist is "not working"; herdr being unreachable is a 502 like elsewhere.
              if (!(e instanceof HerdrError) || !isPaneNotFound(e.message)) throw e;
            }
            if (!info || info.agent !== "claude" || info.agentStatus !== "working") {
              return json({ error: "not-working", message: "Claude is not working" }, 409);
            }
            // Another request may have sent its Esc while this one waited on getPane. From the check to the claim
            // there is no await, so two concurrent requests cannot both get through.
            if (inCooldown(pane)) return json({ ok: true, deduped: true });
            lastStop.set(pane, now());
            try {
              await opts.herdr.sendKeys(pane, [ESC_KEY]);
            } catch (e) {
              lastStop.delete(pane); // nothing was sent: let a retry through
              throw e;
            }
            return json({ ok: true });
          }
          case "/api/draft": {
            if (!opts.stateDir) return json({ error: "not-found" }, 404);
            if (req.method === "GET") {
              if (!paneId || paneId.length > MAX_PANE_ID_CHARS) return json({ error: "bad-body" }, 400);
              return json({ text: getDraft(opts.stateDir, paneId) });
            }
            if (req.method !== "PUT") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body = (await req.json().catch(() => null)) as { pane?: unknown; text?: unknown } | null;
            if (typeof body?.pane !== "string" || typeof body.text !== "string" || !body.pane || body.pane.length > MAX_PANE_ID_CHARS) {
              return json({ error: "bad-body" }, 400);
            }
            try {
              setDraft(opts.stateDir, body.pane, body.text);
            } catch (e) {
              if (e instanceof DraftTooLongError) return json({ error: "too-long" }, 413);
              throw e;
            }
            return json({ ok: true });
          }
          case "/api/settings": {
            if (req.method === "GET") {
              return json({
                settings: settingsStore.get(),
                schema: { groups: GROUPS, settings: SCHEMA },
                about: { version: opts.version ?? "", stateDir: opts.stateDir ?? "" },
              });
            }
            if (req.method !== "PUT") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body: unknown = await req.json().catch(() => null);
            if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "bad-body" }, 400);
            const result = settingsStore.update(body);
            if (result.changed) pushSettings(result.settings);
            focusPoller?.wake(); // followFocus may have been turned on
            return json({ settings: result.settings, rejected: result.rejected });
          }
          case "/api/image": {
            // An image pasted into the terminal lives in the transcript as base64; the window shows it as a data: URL.
            // This serves the same bytes by exchange and block, so the shell's lightbox window can load it by URL.
            // Any exchange of the pane's session, by id (the window may have loaded older blocks): the history index
            // finds it, indexing backwards if it has to.
            const exId = url.searchParams.get("ex");
            const block = /^([ua])(\d{1,4})$/.exec(url.searchParams.get("block") ?? "");
            if (!paneId || paneId.length > MAX_PANE_ID_CHARS || !isExchangeId(exId) || !block) return json({ error: "bad-request" }, 400);
            const loc = await locate(paneId);
            const ex = loc.file ? await history.exchange(loc.file, exId) : null;
            const b = ex ? (block[1] === "u" ? ex.user : ex.assistant)[Number(block[2])] : undefined;
            const m = b?.kind === "image" ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(b.dataUrl) : null;
            if (!m) return json({ error: "not-found" }, 404);
            return new Response(Buffer.from(m[2]!, "base64"), {
              headers: {
                "content-type": m[1]!,
                "cache-control": "private, max-age=300",
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox",
              },
            });
          }
          case "/api/media": {
            // The Media & Links panel: the session's images and links, newest first, a page at a time.
            if (req.method !== "GET") return json({ error: "method" }, 405);
            const site = req.headers.get("sec-fetch-site");
            if (site !== null && site !== "same-origin" && site !== "none") return json({ error: "cross-site" }, 403);
            const kind = url.searchParams.get("kind");
            if (kind !== "images" && kind !== "links") return json({ error: "bad-request", message: "kind is images or links" }, 400);
            if (!paneId || paneId.length > MAX_PANE_ID_CHARS) return json({ error: "bad-request" }, 400);
            const limitRaw = url.searchParams.get("limit");
            const limit = limitRaw === null || limitRaw === "" ? MEDIA_PAGE : /^\d{1,4}$/.test(limitRaw) ? Math.min(MAX_MEDIA_PAGE, Math.max(1, Number(limitRaw))) : null;
            if (limit === null) return json({ error: "bad-request", message: "limit is not a number" }, 400);
            const cursorRaw = url.searchParams.get("cursor");
            const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
            if (cursorRaw && !cursor) return json({ error: "bad-request", message: "not a cursor" }, 400);
            const loc = await locate(paneId);
            const empty = { kind, items: [], next: null, progress: 1, complete: true, total: 0, ...(loc.error ? { error: loc.error } : {}) };
            if (!loc.file) return json(empty);
            const page = await history.media(loc.file, { kind, cursor, limit });
            if (page === "stale") return json({ error: "stale-cursor", message: "The session changed; start from the top." }, 410);
            if (page === null) return json(empty);
            const items = kind === "images" ? (page.images ?? []).map((m) => mediaImageItem(paneId, m)) : (page.links ?? []).map(mediaLinkItem);
            return json({ kind, items, next: page.next ? encodeCursor(page.next) : null, progress: page.progress, complete: page.complete, total: page.total });
          }
          case "/api/file": {
            const target = expandHome(url.searchParams.get("path") ?? "");
            if (!isImagePath(target) || !isAllowedFile(target, await allowedPaths(paneId), opts.attachmentsDir)) {
              return json({ error: "forbidden" }, 403);
            }
            if (!existsSync(target)) return json({ error: "not-found" }, 404);
            return new Response(Bun.file(target), {
              headers: {
                "cache-control": "private, max-age=300",
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox",
              },
            });
          }
          case "/api/open": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const body = (await req.json()) as { pane?: string; kind?: string; target?: string };
            const target = String(body.target ?? "");
            if (body.kind === "url") {
              if (!/^https?:\/\//i.test(target)) return json({ error: "bad-url" }, 400);
              await opts.opener(target);
              return json({ ok: true });
            }
            if (body.kind === "dir") {
              // A folder: the path must be one the conversation mentions (or hold a file it mentions), exist and be a folder.
              const r = resolveDir(body.target, await allowedPaths(String(body.pane ?? "")));
              if ("error" in r) return json({ error: r.error, message: r.message }, DIR_STATUS[r.error]);
              // The window links every extensionless path as a folder: one that is a regular file is shown in its folder instead.
              if ("file" in r) {
                await opts.opener(r.file, "reveal");
                return json({ ok: true, revealed: true });
              }
              await opts.opener(r.dir, "dir");
              return json({ ok: true });
            }
            if (body.kind === "reveal") {
              // Show a file in its folder: no type check (it is only pointed at, never run), the same allow-list as opening it.
              const r = resolveReveal(body.target, await allowedPaths(String(body.pane ?? "")), opts.attachmentsDir);
              if ("error" in r) return json({ error: r.error, message: r.message }, DIR_STATUS[r.error]);
              await opts.opener(r.path, "reveal");
              return json({ ok: true });
            }
            const p = expandHome(target);
            if (!isOpenablePath(p)) {
              return json({ error: "type-not-openable", message: "this file type is not opened from here" }, 403);
            }
            // The same text and real-path checks as folders and "show in folder" (no stream, no control or formatting characters,
            // no network or device path, no trailing dot), then the allow-list and the disk.
            const r = resolveOpen(p, await allowedPaths(String(body.pane ?? "")), opts.attachmentsDir);
            if ("error" in r) return json(r.error === "bad-path" ? { error: r.error, message: r.message } : { error: r.error }, DIR_STATUS[r.error]);
            await opts.opener(r.path);
            return json({ ok: true });
          }
          case "/api/window-bounds": {
            if (req.method !== "POST") return json({ error: "method" }, 405);
            if (!opts.stateDir) return json({ error: "not-found" }, 404);
            if (!hasJsonBody(req)) return json({ error: "unsupported-media-type" }, 415);
            const bounds = validateBounds(await req.json().catch(() => null));
            if (!bounds) return json({ error: "bad-bounds" }, 400);
            writeBounds(opts.stateDir, bounds);
            return json({ ok: true });
          }
          default:
            return json({ error: "not-found" }, 404);
        }
      } catch (e) {
        if (e instanceof SidecrError) return json({ error: e.code, message: e.message }, 409);
        if (e instanceof HerdrError) return json({ error: "herdr", message: e.message }, 502);
        return json({ error: "internal", message: String(e) }, 500);
      }
    },
  });

  /** Stops the focus poller and the server (server.stop alone would leave the poller running for a registered window). */
  const stop = (closeActiveConnections = false): void => {
    focusPoller?.stop();
    void server.stop(closeActiveConnections);
  };

  return { server, stats, focus: focusPoller, stop };
}
