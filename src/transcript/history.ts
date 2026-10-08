/**
 * The session history index: for a transcript file, where each exchange begins (a byte offset), with a stable id, so
 * the window can page back through a long session one block at a time without the server parsing the whole file.
 *
 * - Tail first. A new index reads the end of the file and steps backwards only until it has the latest turns; older
 *   parts are indexed on demand, backwards, one chunk per step with a yield between steps (the event loop is never
 *   held for more than one chunk of scanning).
 * - Append aware. It remembers the scanned size and scans only new bytes; a file that shrank or whose first bytes
 *   changed (replaced) is indexed again from the tail, under a new epoch.
 * - Bounded. At most MAX_SESSIONS files (least recently used goes), MAX_EXCHANGES offsets per file.
 *
 * A row's role is decided once, while scanning (src/transcript/parse.ts exchangeStart, with the queued-twin state of
 * the rows before it). A block is then parsed from its byte range only: a row at a known start begins an exchange,
 * assistant rows fill it. The twin check looks back 50 rows, so every chunk (the tail window too) is scanned after
 * WARMUP_ROWS (200) whole rows before it, however many bytes they take (up to MAX_WARMUP_BYTES); only the rows that
 * can touch the twin state are parsed there. That covers chains of the same queued text three deep.
 *
 * Pages are parsed a chunk at a time with yields, and only the start row and assistant rows are parsed (tool results
 * are never materialised). Closed exchanges never change: once parsed they are kept in a small per-session cache. The
 * last exchange, which may still grow, is parsed incrementally from where the previous request stopped. So a refresh
 * reads only the appended bytes, whatever the size of the turn.
 *
 * Pure core: the file is read only through the injected TranscriptReader (src/transcript/reader.ts in production).
 */
import { TAIL_BYTES } from "../config";
import { collectPaths, expandHome } from "../links";
import { collectMedia } from "./media";
import { addAssistantRow, exchangeStart, finishTokens, isIgnoredRow, lastTurnsStart, newTwinState, QUEUED_TWIN_ROWS, type Exchange, type ExchangeStart, type TwinState, type Usage } from "./parse";

export interface TranscriptReader {
  /** The file's size in bytes, or null when it cannot be read (gone). */
  size(file: string): number | null;
  /** The bytes [start, end) (fewer at the end of the file). */
  read(file: string, start: number, end: number): Uint8Array;
}

export const MAX_SESSIONS = 4;
export const MAX_EXCHANGES = 20_000;
/** Paths remembered per session for the /api/file and /api/open allow-list. */
export const MAX_PATHS = 20_000;
/** The most bytes one synchronous scan step reads (a single longer row is read whole, it cannot be split). */
export const SCAN_CHUNK_BYTES = 1024 * 1024;
/** Whole rows scanned before a chunk for the queued-twin state: four times its 50-row look-back (chains). */
export const WARMUP_ROWS = 4 * QUEUED_TWIN_ROWS;
/** When queued rows sit at the very start of the warm-up, it doubles up to this many rows. */
export const MAX_WARMUP_ROWS = 64 * WARMUP_ROWS;
/** Warm-up bytes kept in memory for the next backward steps, at most (per session). */
const MAX_KEPT_WARMUP_BYTES = 16 * 1024 * 1024;
const KEPT_WARMUPS = 3;
/** The warm-up never reads further back than this (rows that long are tool output, not queued messages). */
export const MAX_WARMUP_BYTES = 32 * 1024 * 1024;
/** Parsed closed exchanges kept per session for the next refresh. */
export const PARSE_CACHE_ENTRIES = 400;
export const PARSE_CACHE_BYTES = 32 * 1024 * 1024;
export const FIRST_TAIL_BYTES = TAIL_BYTES;
const HEAD_BYTES = 256;
/** Longer uuids (untrusted) are not used as ids: the offset stands in. */
const MAX_UUID_CHARS = 120;
/** The Media & Links index keeps at most this many images and links per session (the newest). */
export const MAX_MEDIA = 5000;
export const MAX_LINKS = 5000;
/** How long a media request may index older exchanges before it answers with what is ready. */
const MEDIA_SYNC_STEPS = 3;

/** An image of the session: a pasted image block, or an image path in the text. */
export interface MediaImage {
  /** Where its exchange begins, and its order there: newest first is (offset, seq) descending. */
  offset: number;
  seq: number;
  exchangeId: string;
  kind: "block" | "path";
  /** For a block: its index among the user's blocks. */
  block?: number;
  /** For a path: as written (the window's /api/file URL takes it as is). */
  path?: string;
  /** The exchange's start time. */
  at?: string;
}

/** A link of the session, deduplicated by its normalised URL. */
export interface MediaLink {
  url: string;
  norm: string;
  host: string;
  title?: string;
  /** Mentions in the indexed exchanges. */
  count: number;
  /** The first (oldest) mention: its exchange, its start time. */
  exchangeId: string;
  at?: string;
  firstOffset: number;
  firstSeq: number;
  /** The latest mention. The list is sorted by the first mention, newest first. */
  lastOffset: number;
  lastSeq: number;
}

/** Where a media page ends: the last item's position (and URL, for links), and the epoch it belongs to. */
export interface MediaCursor {
  e: number;
  o: number;
  q: number;
  n?: string;
}

export interface MediaPage {
  images?: MediaImage[];
  links?: MediaLink[];
  /** The cursor of the next page; null only at the very end (everything indexed and returned). */
  next: MediaCursor | null;
  /** How much of the file (bytes from the end) the media index covers, 0..1. */
  progress: number;
  complete: boolean;
  epoch: number;
  /** Items of this kind indexed so far. */
  total: number;
}

interface MediaIndex {
  /** Closed exchanges' images, newest first. */
  images: MediaImage[];
  /** Expanded path -> its (newest) image item: a path shows once. */
  byPath: Map<string, MediaImage>;
  links: Map<string, MediaLink>;
  /** Exchanges starting in [oldestOffset, newestOffset) are indexed; the one at newestOffset onwards is open. */
  oldestOffset: number;
  newestOffset: number;
  complete: boolean;
  running: boolean;
}

const pathKey = (p: string): string => {
  const x = expandHome(p);
  return /^[A-Za-z]:\\/.test(x) ? x.toLowerCase() : x;
};
const imageOlder = (a: { offset: number; seq: number }, o: number, q: number): boolean => a.offset < o || (a.offset === o && a.seq < q);
const linkBefore = (a: MediaLink, b: MediaLink): number =>
  b.firstOffset - a.firstOffset || b.firstSeq - a.firstSeq || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0);

export interface Page {
  /** Oldest first. */
  exchanges: Exchange[];
  /** There are older exchanges before the first one returned. */
  hasMore: boolean;
  /** The id of the first exchange returned (the `before` of the next older block), or null when none. */
  oldestId: string | null;
  /** Changes when the file is indexed again (replaced, shrunk, evicted and rebuilt): older ids are no longer valid. */
  epoch: number;
  /** No more because MAX_EXCHANGES was reached, not because this is the beginning of the session. */
  truncated?: boolean;
}

export interface HistoryOptions {
  reader: TranscriptReader;
  maxSessions?: number;
  maxExchanges?: number;
  chunkBytes?: number;
  /** Rows of warm-up for the queued-twin check before a chunk (default WARMUP_ROWS). */
  warmupRows?: number;
  maxWarmupBytes?: number;
  firstTailBytes?: number;
  /** Parsed closed exchanges kept per session: at most this many, of at most this estimated size. */
  cacheEntries?: number;
  cacheBytes?: number;
  /** Lets other work run between scan steps. Default: setImmediate. */
  yieldNow?: () => Promise<void>;
}

const P_USER = Buffer.from('"user"');
const P_ATTACHMENT = Buffer.from('"attachment"');
const P_ASSISTANT = Buffer.from('"assistant"');
/**
 * Every row that can touch the twin state has one of these keys or values, unescaped (an attachment of type
 * `"queued_command"`, a user row with `"promptSource"`). Text that merely quotes them (tool output, code) has them
 * escaped (`\"promptSource\"`), so it does not match.
 */
const P_QUEUED_COMMAND = Buffer.from('"queued_command"');
const P_PROMPT_SOURCE = Buffer.from('"promptSource"');

/** A row the queued-twin check acts on (a superset: what exchangeStart would add to or take from the twin state). */
export function touchesTwins(row: any): boolean {
  if (!row || typeof row !== "object") return false;
  if (row.type === "attachment") return row.attachment?.type === "queued_command";
  return row.type === "user" && row.promptSource === "queued";
}
const NL = 10;
const CR = 13;

const asBuffer = (u: Uint8Array): Buffer => (Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength));

/** Each non-empty line in buf[from, to), as [start, end) without the line break. `to` ends a line (or the data). */
export function eachLine(buf: Buffer, from: number, to: number, fn: (s: number, e: number) => void): void {
  let s = from;
  while (s < to) {
    let nl = buf.indexOf(NL, s);
    if (nl < 0 || nl >= to) nl = to;
    let e = nl;
    if (e > s && buf[e - 1] === CR) e--;
    if (e > s) fn(s, e);
    s = nl + 1;
  }
}

/** The first line start at or after `rel` in buf; `bufAtLineStart` says whether buf[0] begins a line. -1: none. */
export function lineStartAtOrAfter(buf: Buffer, rel: number, bufAtLineStart: boolean): number {
  if (rel === 0 && bufAtLineStart) return 0;
  if (rel > 0 && buf[rel - 1] === NL) return rel;
  const nl = buf.indexOf(NL, rel);
  return nl < 0 ? -1 : nl + 1;
}

interface Found {
  offset: number;
  start: ExchangeStart;
}

/**
 * Scans the lines of buf[from, to) for exchange starts, in order, with the given twin state (updated). Only starts at
 * absolute offsets >= recordFrom are returned. A line that can be neither a user row nor an attachment is not parsed.
 * `warm`: warm-up rows before a chunk, only for the twin state: only rows that can touch it are parsed, none recorded.
 */
export function scanStarts(buf: Buffer, base: number, from: number, to: number, recordFrom: number, twins: TwinState, line: number, warm = false): { found: Found[]; line: number; firstQueued?: number } {
  const found: Found[] = [];
  let firstQueued: number | undefined;
  eachLine(buf, from, to, (s, e) => {
    const at = line++;
    const view = buf.subarray(s, e);
    if (warm ? view.indexOf(P_QUEUED_COMMAND) < 0 && view.indexOf(P_PROMPT_SOURCE) < 0 : view.indexOf(P_USER) < 0 && view.indexOf(P_ATTACHMENT) < 0) return;
    let row: unknown;
    try {
      row = JSON.parse(buf.toString("utf8", s, e));
    } catch {
      return;
    }
    // Only a row the twin check really acts on counts (a row that merely mentions "queued" never triggers the doubling).
    if (firstQueued === undefined && touchesTwins(row)) firstQueued = at;
    const start = exchangeStart(row, twins, at);
    if (start && !warm && base + s >= recordFrom) found.push({ offset: base + s, start });
  });
  return { found, line, ...(firstQueued !== undefined ? { firstQueued } : {}) };
}

/** A parsed exchange kept for the next request (closed exchanges never change). */
interface Parsed {
  end: number;
  id: string;
  ex: Exchange;
  cost: number;
}

/** The last exchange, parsed incrementally: only the bytes appended since the last request are read. */
interface OpenParse {
  offset: number;
  id: string;
  parsedTo: number;
  ex: Exchange | null;
  usage: Usage;
}

interface Session {
  file: string;
  built: boolean;
  epoch: number;
  head: Buffer;
  /** Bytes [0, scannedTo) are complete lines that were seen; the tail beyond is new or a partial line. */
  scannedTo: number;
  /** Every exchange starting in [coveredFrom, scannedTo) is indexed. 0: the whole file. */
  coveredFrom: number;
  /** MAX_EXCHANGES was reached: older exchanges are not indexed and not offered. */
  truncated: boolean;
  starts: number[];
  ids: string[];
  queued: boolean[];
  ts: (string | undefined)[];
  prompts: number;
  byId: Map<string, number>;
  /** The twin state and line count at scannedTo, for the next appended rows. */
  twins: TwinState;
  line: number;
  paths: Set<string>;
  /** The bytes of the last warm-ups (before a chunk start), newest first: the next backward step reads them again. */
  kept: { from: number; to: number; buf: Buffer }[];
  /** Closed exchanges already parsed, by start offset (least recently used first), and their estimated size. */
  parsed: Map<number, Parsed>;
  parsedCost: number;
  open: OpenParse | null;
  /** Closed exchanges whose paths are in `paths` already. */
  noted: WeakSet<Exchange>;
  media: MediaIndex | null;
}

/** A rough size of a parsed exchange in memory (its strings), for the cache's budget. */
function costOf(ex: Exchange): number {
  let n = 200;
  for (const b of [...ex.user, ...ex.assistant]) {
    if (b.kind === "text") n += b.text.length * 2;
    else if (b.kind === "image") n += b.dataUrl.length * 2;
    else n += 100 + b.items.reduce((c, i) => c + (i.name.length + i.summary.length) * 2, 0);
  }
  return n;
}

let epochs = 0;

export function createHistory(opts: HistoryOptions) {
  const reader = opts.reader;
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const maxExchanges = opts.maxExchanges ?? MAX_EXCHANGES;
  const chunkBytes = opts.chunkBytes ?? SCAN_CHUNK_BYTES;
  const warmupRows = opts.warmupRows ?? WARMUP_ROWS;
  const maxWarmupBytes = opts.maxWarmupBytes ?? MAX_WARMUP_BYTES;
  const firstTailBytes = opts.firstTailBytes ?? FIRST_TAIL_BYTES;
  const cacheEntries = opts.cacheEntries ?? PARSE_CACHE_ENTRIES;
  const cacheBytes = opts.cacheBytes ?? PARSE_CACHE_BYTES;
  const yieldNow = opts.yieldNow ?? (() => new Promise<void>((r) => setImmediate(r)));
  const sessions = new Map<string, Session>();
  // One operation per file at a time (a block request and a refresh of the same session must not interleave).
  const locks = new Map<string, Promise<void>>();

  const readFile = (s: Session, start: number, end: number): Buffer => asBuffer(reader.read(s.file, start, end));
  /** Bytes [start, end), from the kept warm-up bytes where they overlap, else from the file. */
  function read(s: Session, start: number, end: number): Buffer {
    if (s.kept.length === 0) return readFile(s, start, end);
    const parts: Buffer[] = [];
    for (let pos = start; pos < end; ) {
      const k = s.kept.find((x) => x.from <= pos && pos < x.to);
      if (k) {
        const e = Math.min(end, k.to);
        parts.push(k.buf.subarray(pos - k.from, e - k.from));
        pos = e;
      } else {
        let next = end;
        for (const x of s.kept) if (x.from > pos && x.from < next) next = x.from;
        parts.push(readFile(s, pos, next));
        pos = next;
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Keeps warm-up bytes for the next steps: at most KEPT_WARMUPS buffers, MAX_KEPT_WARMUP_BYTES in all. */
  function keep(s: Session, from: number, to: number, buf: Buffer): void {
    if (buf.length > MAX_KEPT_WARMUP_BYTES || to <= from) return;
    s.kept.unshift({ from, to, buf });
    let total = 0;
    s.kept = s.kept.filter((x, i) => i < KEPT_WARMUPS && (total += x.buf.length) <= MAX_KEPT_WARMUP_BYTES);
  }

  function blank(file: string): Session {
    return {
      file, built: false, epoch: ++epochs, head: Buffer.alloc(0), scannedTo: 0, coveredFrom: 0, truncated: false,
      starts: [], ids: [], queued: [], ts: [], prompts: 0, byId: new Map(), twins: newTwinState(), line: 0,
      paths: new Set(), parsed: new Map(), parsedCost: 0, open: null, noted: new WeakSet(),
      media: null, kept: [],
    };
  }

  function idFor(s: Session, f: Found): string {
    const u = f.start.uuid;
    let id = u !== undefined && u !== null && String(u) !== "" && String(u).length <= MAX_UUID_CHARS ? String(u) : `@${f.offset}`;
    if (s.byId.has(id) && s.byId.get(id) !== f.offset) id = `${id}@${f.offset}`;
    return id;
  }

  function prepend(s: Session, found: Found[], newCoveredFrom: number): void {
    const room = maxExchanges - s.starts.length;
    if (found.length > room) {
      found = room > 0 ? found.slice(found.length - room) : [];
      s.truncated = true;
      newCoveredFrom = found[0]?.offset ?? s.starts[0] ?? s.scannedTo;
    }
    s.coveredFrom = newCoveredFrom;
    if (found.length === 0) return;
    const ids = found.map((f) => {
      const id = idFor(s, f);
      s.byId.set(id, f.offset);
      return id;
    });
    s.starts = found.map((f) => f.offset).concat(s.starts);
    s.ids = ids.concat(s.ids);
    s.queued = found.map((f) => f.start.queued).concat(s.queued);
    s.ts = found.map((f) => f.start.ts).concat(s.ts);
    s.prompts += found.reduce((c, f) => c + (f.start.queued ? 0 : 1), 0);
  }

  function append(s: Session, found: Found[]): void {
    for (const f of found) {
      const id = idFor(s, f);
      s.byId.set(id, f.offset);
      s.starts.push(f.offset);
      s.ids.push(id);
      s.queued.push(f.start.queued);
      s.ts.push(f.start.ts);
      if (!f.start.queued) s.prompts++;
    }
    const over = s.starts.length - maxExchanges;
    if (over > 0) {
      for (let i = 0; i < over; i++) {
        s.byId.delete(s.ids[i]!);
        if (!s.queued[i]) s.prompts--;
      }
      s.starts.splice(0, over);
      s.ids.splice(0, over);
      s.queued.splice(0, over);
      s.ts.splice(0, over);
      s.truncated = true;
      s.coveredFrom = s.starts[0] ?? s.scannedTo;
    }
  }

  const canExtend = (s: Session): boolean => s.coveredFrom > 0 && !s.truncated;

  /** The first "\n" in [from, limit), searched forward a chunk at a time with a yield between chunks; -1: none. */
  async function newlineForward(s: Session, from: number, limit: number): Promise<number> {
    let pos = from;
    while (pos < limit) {
      const end = Math.min(limit, pos + chunkBytes);
      const i = read(s, pos, end).indexOf(NL);
      if (i >= 0) return pos + i;
      pos = end;
      if (pos < limit) await yieldNow();
    }
    return -1;
  }

  /** The last "\n" in [floor, to), searched backwards a chunk at a time with a yield between chunks; -1: none. */
  async function newlineBackward(s: Session, to: number, floor = 0): Promise<number> {
    let end = to;
    while (end > floor) {
      const start = Math.max(floor, end - chunkBytes);
      const i = read(s, start, end).lastIndexOf(NL);
      if (i >= 0) return start + i;
      end = start;
      if (end > floor) await yieldNow();
    }
    return -1;
  }

  /** The first row start in [a, b) (b is a row start); when one row covers all of it, where that row starts. */
  async function chunkStart(s: Session, a: number, b: number): Promise<number> {
    if (a <= 0) return 0;
    const nl = await newlineForward(s, a - 1, b - 1); // byte b-1 is the "\n" that ends the row before b
    if (nl >= 0) return nl + 1;
    return (await newlineBackward(s, a - 1)) + 1; // -1 + 1: the row starts the file
  }

  /**
   * Where the warm-up before a chunk starting at `rec` begins: `warmupRows` whole rows back (fewer at the start of
   * the file, or when they span more than maxWarmupBytes). Counted in rows, not bytes: the twin check looks back 50 rows
   * however long they are.
   */
  /** The bytes before a chunk start `rec`, read backwards once, with the rows counted so far. */
  interface Back {
    rec: number;
    floor: number;
    /** Pieces covering [from, rec), oldest first. */
    pieces: Buffer[];
    from: number;
    /** Newlines counted backwards from rec-1 (the one ending the row before rec is the first). */
    seen: number;
    /** The lowest newline counted (rec when none yet). */
    low: number;
  }

  const newBack = (rec: number): Back => ({ rec, floor: Math.max(0, rec - maxWarmupBytes), pieces: [], from: rec, seen: 0, low: rec });

  /**
   * Where `rows` whole rows before `back.rec` begin (fewer at the start of the file, or at maxWarmupBytes back),
   * reading backwards a chunk at a time with yields. Continues from where an earlier call stopped: nothing is read twice.
   */
  async function countBack(s: Session, back: Back, rows: number): Promise<number> {
    if (back.rec <= 0 || rows <= 0) return back.rec;
    for (;;) {
      const first = back.pieces[0];
      if (first) {
        for (let i = Math.min(back.low - back.from, first.length) - 1; i >= 0; ) {
          const j = first.lastIndexOf(NL, i);
          if (j < 0) break;
          back.seen++;
          back.low = back.from + j;
          if (back.seen >= rows + 1) return back.low + 1;
          i = j - 1;
        }
      }
      if (back.from <= back.floor) {
        if (back.floor === 0) return 0;
        return back.low + 1; // the cap: the first row start after it (rec itself when none)
      }
      const start = Math.max(back.floor, back.from - chunkBytes);
      back.pieces.unshift(read(s, start, back.from));
      back.from = start;
      await yieldNow();
    }
  }

  /** The warm-up bytes [w, rec) as one buffer (kept for the next step when small). */
  function warmBytes(s: Session, back: Back, w: number): Buffer {
    const all = back.pieces.length === 1 ? back.pieces[0]! : Buffer.concat(back.pieces);
    back.pieces = [all];
    keep(s, back.from, back.rec, all);
    return all.subarray(w - back.from);
  }

  /** Scans warm-up rows held in memory, a chunk at a time with yields, for the twin state only. */
  async function scanWarm(buf: Buffer, base: number, twins: TwinState): Promise<{ line: number; firstQueued?: number }> {
    let line = 0;
    let firstQueued: number | undefined;
    for (let pos = 0; pos < buf.length; ) {
      let end = Math.min(buf.length, pos + chunkBytes);
      const nl = end < buf.length ? buf.lastIndexOf(NL, end - 1) : buf.length - 1;
      end = nl >= pos ? nl + 1 : buf.indexOf(NL, end) + 1 || buf.length; // a row longer than a chunk: to its end
      const r = scanStarts(buf, base, pos, end, Number.POSITIVE_INFINITY, twins, line, true);
      line = r.line;
      firstQueued ??= r.firstQueued;
      pos = end;
      if (pos < buf.length) await yieldNow();
    }
    return { line, ...(firstQueued !== undefined ? { firstQueued } : {}) };
  }

  /**
   * Each complete row of [from, to) in order, read a chunk at a time with a yield between chunks. A row longer than a
   * chunk is read whole once its end is found (it cannot be split). A partial row at `to` is left out. Returns the
   * end of the last complete row.
   */
  async function eachRow(s: Session, from: number, to: number, fn: (buf: Buffer, base: number, end: number) => void): Promise<number> {
    let pos = from;
    while (pos < to) {
      const end = Math.min(to, pos + chunkBytes);
      let buf = read(s, pos, end);
      let lastNl = buf.lastIndexOf(NL);
      if (lastNl < 0) {
        if (end >= to) break; // a row still being written
        const nl = await newlineForward(s, end, to);
        if (nl < 0) break;
        buf = read(s, pos, nl + 1);
        lastNl = buf.length - 1;
      }
      fn(buf, pos, lastNl + 1);
      pos += lastNl + 1;
      if (pos < to) await yieldNow();
    }
    return pos;
  }

  /** Scans [from, to) for starts (recording those at or after recordFrom), a chunk at a time. */
  async function scanRange(s: Session, from: number, to: number, recordFrom: number, twins: TwinState, line: number, warm: boolean, found: Found[]): Promise<{ end: number; line: number; firstQueued?: number }> {
    let ln = line;
    let firstQueued: number | undefined;
    const end = await eachRow(s, from, to, (buf, base, e) => {
      const r = scanStarts(buf, base, 0, e, recordFrom, twins, ln, warm);
      ln = r.line;
      firstQueued ??= r.firstQueued;
      for (const f of r.found) found.push(f);
    });
    return { end, line: ln, ...(firstQueued !== undefined ? { firstQueued } : {}) };
  }

  /**
   * The twin state at `rec`, from warm-up rows before it. It is exact when no row in the first 50 warm-up rows is one
   * the twin check acts on (anything older has expired by then); otherwise the warm-up is doubled, up to
   * MAX_WARMUP_ROWS rows or maxWarmupBytes (a chain of the same queued text that long is taken as it comes). The bytes
   * are read once (a doubling reads only the rows further back) and scanned from memory.
   */
  async function warmState(s: Session, rec: number, known?: { back: Back; w: number }): Promise<{ twins: TwinState; line: number }> {
    const back = known?.back ?? newBack(rec);
    let rows = warmupRows;
    let w = known?.w ?? (await countBack(s, back, rows));
    for (;;) {
      const twins = newTwinState();
      if (w >= rec) return { twins, line: 0 };
      const r = await scanWarm(warmBytes(s, back, w), w, twins);
      await yieldNow();
      const exact = w === 0 || r.firstQueued === undefined || r.firstQueued >= QUEUED_TWIN_ROWS;
      if (exact || rows >= MAX_WARMUP_ROWS || rec - w >= maxWarmupBytes) return { twins, line: r.line };
      rows *= 2;
      w = await countBack(s, back, rows);
    }
  }

  /** Indexes [rec, b) with the twin state of the warm-up rows before rec. */
  async function scanChunk(s: Session, rec: number, b: number, known?: { back: Back; w: number }): Promise<{ found: Found[]; twins: TwinState; line: number }> {
    const warm = await warmState(s, rec, known);
    const twins = warm.twins;
    const found: Found[] = [];
    let line = warm.line;
    line = (await scanRange(s, rec, b, rec, twins, line, false, found)).line;
    return { found, twins, line };
  }

  /** The first index of a new session: the end of the file, back to the first row start of the tail window. */
  async function build(s: Session): Promise<boolean> {
    const size = reader.size(s.file);
    if (size === null) return false;
    s.head = Buffer.from(read(s, 0, Math.min(HEAD_BYTES, size)));
    const lastNl = await newlineBackward(s, size);
    if (lastNl < 0) {
      // No complete row yet (an empty file, or a first row still being written).
      s.scannedTo = 0;
      s.coveredFrom = 0;
      s.built = true;
      return true;
    }
    const end = lastNl + 1;
    await yieldNow();
    const rec = await chunkStart(s, Math.max(0, end - firstTailBytes), end);
    await yieldNow();
    const r = await scanChunk(s, rec, end);
    s.twins = r.twins;
    s.line = r.line;
    s.scannedTo = end;
    s.coveredFrom = rec;
    append(s, r.found);
    if (s.truncated) s.coveredFrom = s.starts[0] ?? s.scannedTo;
    s.built = true;
    return true;
  }

  /** One backward step: indexes the chunk before coveredFrom. False when there is nothing more to index. */
  async function extendBackStep(s: Session): Promise<boolean> {
    if (!canExtend(s)) return false;
    const b = s.coveredFrom;
    let rec = await chunkStart(s, Math.max(0, b - chunkBytes), b);
    await yieldNow();
    // Long rows: the warm-up's 200 rows would span more than the chunk. Then the step records those rows too (they
    // are read anyway, and kept: the step reads them from memory), so the warm-up never costs more than the step indexes.
    const back = newBack(rec);
    const w = await countBack(s, back, warmupRows);
    const long = rec - w > chunkBytes;
    if (long) {
      warmBytes(s, back, w);
      rec = w;
    }
    const r = await scanChunk(s, rec, b, long ? undefined : { back, w });
    prepend(s, r.found, rec);
    return true;
  }

  /** The file still starts as it did; a head seen short (a file under HEAD_BYTES) is completed as the file grows. */
  function sameHead(s: Session, size: number): boolean {
    const want = Math.min(HEAD_BYTES, size);
    const now = read(s, 0, want);
    if (!now.subarray(0, s.head.length).equals(s.head)) return false;
    if (s.head.length < want) s.head = Buffer.from(now);
    return true;
  }

  /** Scans what was appended since the last call. "replaced": the file shrank or its start changed; "gone": unreadable. */
  async function syncForward(s: Session): Promise<"ok" | "replaced" | "gone"> {
    const size = reader.size(s.file);
    if (size === null) return "gone";
    if (size < s.scannedTo || !sameHead(s, size)) return "replaced";
    if (size === s.scannedTo) return "ok";
    const found: Found[] = [];
    const r = await scanRange(s, s.scannedTo, size, 0, s.twins, s.line, false, found);
    s.line = r.line;
    s.scannedTo = r.end;
    append(s, found);
    return "ok";
  }

  /** Runs fn on the file's session, up to date, one operation per session at a time. Null: the file cannot be read. */
  function withSession<T>(file: string, fn: (s: Session) => Promise<T> | T): Promise<T | null> {
    const prev = locks.get(file) ?? Promise.resolve();
    const run = prev.then(async () => {
      let s = sessions.get(file);
      if (s) sessions.delete(file);
      else s = blank(file);
      sessions.set(file, s); // most recently used last
      while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value!);
      if (s.built) {
        const state = await syncForward(s);
        if (state === "gone") {
          sessions.delete(file);
          return null;
        }
        if (state === "replaced") {
          s = blank(file);
          sessions.set(file, s);
        }
      }
      if (!s.built && !(await build(s))) {
        sessions.delete(file);
        return null;
      }
      return fn(s);
    });
    const settled = run.then(
      () => {},
      () => {},
    );
    locks.set(file, settled);
    void settled.then(() => {
      if (locks.get(file) === settled) locks.delete(file);
    });
    return run;
  }

  /** startedAt as the full parse gives it: a queued exchange keeps the clock of the one before it. */
  function startedAtOf(s: Session, k: number): string | undefined {
    let j = k;
    while (j > 0 && s.queued[j]) j--;
    let cur = s.ts[j];
    for (let m = j + 1; m <= k; m++) cur = cur ?? s.ts[m];
    return cur;
  }

  /** The exchange object of index entry k, from its start row (null: the row is not where the index says). */
  function newExchange(s: Session, k: number, start: ExchangeStart | null): Exchange {
    const ex: Exchange = { id: s.ids[k]!, user: start?.user ?? [], assistant: [] };
    if (s.queued[k]) {
      ex.queued = true;
      const at = (k > 0 ? startedAtOf(s, k - 1) : undefined) ?? s.ts[k];
      if (at) ex.startedAt = at;
    } else if (s.ts[k]) ex.startedAt = s.ts[k];
    return ex;
  }

  /**
   * Parses [from, to) of exchange k into `p` (its start row first, when from is the exchange's start), a chunk at a
   * time with yields. Only the start row and assistant rows are parsed: tool results are never materialised.
   */
  async function parseInto(s: Session, k: number, p: { ex: Exchange | null; usage: Usage; parsedTo?: number }, from: number, to: number): Promise<number> {
    const startOffset = s.starts[k]!;
    return eachRow(s, from, to, (buf, base, end) => {
      // `parsedTo` (the last exchange's) moves with each piece parsed: a read that fails on a later piece leaves it
      // exactly at the rows already added, so the next request never adds them twice.
      if (p.parsedTo !== undefined) p.parsedTo = base + end;
      eachLine(buf, 0, end, (a, e) => {
        if (base + a === startOffset) {
          let row: unknown = null;
          try {
            row = JSON.parse(buf.toString("utf8", a, e));
          } catch {
            /* changed under us: the exchange still shows, empty */
          }
          p.ex = newExchange(s, k, exchangeStart(row, newTwinState(), 0));
          return;
        }
        if (buf.subarray(a, e).indexOf(P_ASSISTANT) < 0) return;
        let row: any;
        try {
          row = JSON.parse(buf.toString("utf8", a, e));
        } catch {
          return;
        }
        if (isIgnoredRow(row) || row.type !== "assistant") return;
        p.ex ??= newExchange(s, k, null);
        addAssistantRow(p.ex, row, p.usage);
      });
    });
  }

  function remember(s: Session, offset: number, entry: Parsed): void {
    const old = s.parsed.get(offset);
    if (old) {
      s.parsedCost -= old.cost;
      s.parsed.delete(offset);
    }
    if (entry.cost > cacheBytes) return; // one huge exchange is parsed again when asked for, never kept
    s.parsed.set(offset, entry);
    s.parsedCost += entry.cost;
    while (s.parsed.size > cacheEntries || s.parsedCost > cacheBytes) {
      const [k, v] = s.parsed.entries().next().value!;
      s.parsed.delete(k);
      s.parsedCost -= v.cost;
    }
  }

  /** A closed exchange (k is not the last one), from the cache or parsed (finishing the open parse when it is that one). */
  async function closedExchange(s: Session, k: number, keep: boolean): Promise<Exchange> {
    // The first indexed exchange, with older history still to index: a queued one takes its start time from the
    // exchange before it, which is not known yet. Served, but not kept.
    if (k === 0 && canExtend(s)) keep = false;
    const offset = s.starts[k]!;
    const end = s.starts[k + 1]!;
    const hit = s.parsed.get(offset);
    if (hit && hit.end === end && hit.id === s.ids[k]) {
      s.parsed.delete(offset); // most recently used last
      s.parsed.set(offset, hit);
      return hit.ex;
    }
    let p: { ex: Exchange | null; usage: Usage };
    if (s.open && s.open.offset === offset && s.open.id === s.ids[k] && s.open.parsedTo <= end) {
      p = s.open; // it was the last exchange: only its remaining bytes are read
      await parseInto(s, k, p, s.open.parsedTo, end);
      s.open = null;
    } else {
      p = { ex: null, usage: new Map() };
      await parseInto(s, k, p, offset, end);
    }
    const ex = p.ex ?? newExchange(s, k, null);
    finishTokens([ex], p.usage);
    if (keep) remember(s, offset, { end, id: s.ids[k]!, ex, cost: costOf(ex) });
    return ex;
  }

  /** The last exchange, which may still grow: parsed from where the previous request stopped. */
  async function openExchange(s: Session): Promise<Exchange> {
    const k = s.starts.length - 1;
    const offset = s.starts[k]!;
    if (!s.open || s.open.offset !== offset || s.open.id !== s.ids[k]) {
      // The previous last exchange has closed: finish it into the cache first, so its state is not lost.
      const prev = s.open ? s.starts.indexOf(s.open.offset) : -1;
      if (prev >= 0 && prev < k) await closedExchange(s, prev, true);
      s.open = { offset, id: s.ids[k]!, parsedTo: offset, ex: null, usage: new Map() };
    }
    const o = s.open;
    o.parsedTo = await parseInto(s, k, o, o.parsedTo, s.scannedTo);
    o.ex ??= newExchange(s, k, null);
    finishTokens([o.ex], o.usage);
    return o.ex;
  }

  /** The exchanges of index entries [i, j). `keep`: cache the closed ones (a page); off for the media scan. */
  async function exchangesOf(s: Session, i: number, j: number, keep = true): Promise<Exchange[]> {
    const out: Exchange[] = [];
    const last = s.starts.length - 1;
    for (let k = i; k < j; k++) out.push(k === last ? await openExchange(s) : await closedExchange(s, k, keep));
    return out;
  }

  function notePaths(s: Session, exchanges: Exchange[]): void {
    const last = s.open?.ex ?? null;
    for (const ex of exchanges) {
      if (s.paths.size >= MAX_PATHS) return;
      if (s.noted.has(ex)) continue;
      for (const p of collectPaths([ex])) {
        if (s.paths.size >= MAX_PATHS) break;
        s.paths.add(p);
      }
      if (ex !== last) s.noted.add(ex); // the open exchange may still grow: noted again next time
    }
  }

  function position(s: Session, id: string): number {
    const offset = s.byId.get(id);
    if (offset === undefined) return -1;
    let lo = 0;
    let hi = s.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = s.starts[mid]!;
      if (v === offset) return mid;
      if (v < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Extends backwards until `id` is indexed or nothing is left. */
  async function find(s: Session, id: string): Promise<number> {
    for (;;) {
      const p = position(s, id);
      if (p >= 0 || !(await extendBackStep(s))) return p;
      await yieldNow();
    }
  }

  /** Extends backwards until there are n real prompts before index p (the p-th entry stays the same). */
  async function ensureBefore(s: Session, id: string | null, n: number): Promise<number> {
    for (;;) {
      const p = id === null ? s.starts.length : position(s, id);
      let prompts = 0;
      for (let i = p - 1; i >= 0 && prompts < n; i--) if (!s.queued[i]) prompts++;
      if (prompts >= n || !(await extendBackStep(s))) return p;
      await yieldNow();
    }
  }

  /** The first index whose start is at or after `offset`. */
  function lowerBound(s: Session, offset: number): number {
    let lo = 0;
    let hi = s.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.starts[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function addPath(s: Session, p: string): void {
    if (s.paths.size < MAX_PATHS) s.paths.add(expandHome(p));
  }

  /**
   * Adds one exchange's media to the index, as newer (forward) or older (backward) than what is there. `allow`: the
   * image paths it keeps join the allow-list (off for the scratch copy of the open exchange, which the page adds).
   */
  function addMedia(s: Session, m: MediaIndex, ex: Exchange, offset: number, side: "newer" | "older", allow = true): void {
    const found = collectMedia(ex);
    const items: MediaImage[] = [];
    found.images.forEach((im, seq) => {
      const item: MediaImage = { offset, seq, exchangeId: ex.id, kind: im.kind, ...(im.block !== undefined ? { block: im.block } : {}), ...(im.path ? { path: im.path } : {}), ...(ex.startedAt ? { at: ex.startedAt } : {}) };
      if (im.path) {
        const key = pathKey(im.path);
        const known = m.byPath.get(key);
        if (known && side === "older") return; // a newer mention already shows it
        if (known) m.images.splice(m.images.indexOf(known), 1);
        m.byPath.set(key, item);
      }
      items.push(item);
    });
    items.reverse(); // newest first within the exchange too
    const kept: MediaImage[] = [];
    if (side === "newer") {
      m.images.unshift(...items);
      kept.push(...items);
      while (m.images.length > MAX_MEDIA) {
        const gone = m.images.pop()!;
        if (gone.path && m.byPath.get(pathKey(gone.path)) === gone) m.byPath.delete(pathKey(gone.path));
      }
    } else {
      for (const it of items) {
        if (m.images.length >= MAX_MEDIA) {
          if (it.path && m.byPath.get(pathKey(it.path)) === it) m.byPath.delete(pathKey(it.path));
          continue;
        }
        m.images.push(it);
        kept.push(it);
      }
    }
    // Only an image the panel can list joins the allow-list (the panel shows it through /api/file).
    if (allow) for (const it of kept) if (it.path && m.images.includes(it)) addPath(s, it.path);
    found.links.forEach((l, seq) => {
      const known = m.links.get(l.norm);
      if (known) {
        known.count++;
        if (side === "older") {
          known.exchangeId = ex.id;
          known.firstOffset = offset;
          known.firstSeq = seq;
          if (ex.startedAt) known.at = ex.startedAt;
          else delete known.at;
          if (l.title) known.title = l.title;
          known.url = l.url;
        } else {
          known.lastOffset = offset;
          known.lastSeq = seq;
        }
        return;
      }
      if (m.links.size >= MAX_LINKS) {
        if (side === "older") return;
        let oldest: MediaLink | null = null;
        for (const x of m.links.values()) if (!oldest || linkBefore(x, oldest) > 0) oldest = x;
        if (oldest) m.links.delete(oldest.norm);
      }
      m.links.set(l.norm, {
        url: l.url, norm: l.norm, host: l.host, ...(l.title ? { title: l.title } : {}), count: 1,
        exchangeId: ex.id, ...(ex.startedAt ? { at: ex.startedAt } : {}), firstOffset: offset, firstSeq: seq, lastOffset: offset, lastSeq: seq,
      });
    });
  }

  /** Indexes the exchanges that closed since the last call (all but the last one, which may still grow). */
  async function mediaForward(s: Session, m: MediaIndex): Promise<void> {
    const open = s.starts.length - 1;
    if (open < 0) return;
    const from = lowerBound(s, m.newestOffset);
    if (from < open) {
      const exs = await exchangesOf(s, from, open);
      exs.forEach((ex, j) => addMedia(s, m, ex, s.starts[from + j]!, "newer"));
    }
    m.newestOffset = Math.max(m.newestOffset, s.starts[open]!);
  }

  /** One backward step: a chunk's worth of older exchanges into the media index. False when done. */
  async function mediaBackStep(s: Session, m: MediaIndex): Promise<boolean> {
    if (m.complete) return false;
    if (m.images.length >= MAX_MEDIA && m.links.size >= MAX_LINKS) {
      m.complete = true;
      return false;
    }
    const p = lowerBound(s, m.oldestOffset);
    if (p <= 0) {
      if (await extendBackStep(s)) return true;
      m.complete = true;
      return false;
    }
    let k = p - 1;
    while (k > 0 && m.oldestOffset - s.starts[k - 1]! <= chunkBytes) k--;
    // The same for the media scan: a queued first exchange gets its turn's start time once the one before it is indexed.
    if (k === 0 && canExtend(s) && s.queued[0]) return extendBackStep(s);
    const exs = await exchangesOf(s, k, p, false);
    for (let j = exs.length - 1; j >= 0; j--) addMedia(s, m, exs[j]!, s.starts[k + j]!, "older");
    m.oldestOffset = s.starts[k]!;
    return true;
  }

  function mediaOf(s: Session): MediaIndex {
    if (!s.media) {
      const start = s.starts.at(-1) ?? s.scannedTo;
      s.media = { images: [], byPath: new Map(), links: new Map(), oldestOffset: start, newestOffset: start, complete: false, running: false };
    }
    return s.media;
  }

  /** Keeps indexing older exchanges in the background, one step per turn of the event loop, until done. */
  async function runMedia(file: string, s: Session, m: MediaIndex): Promise<void> {
    if (m.running || m.complete) return;
    m.running = true;
    try {
      while (!m.complete && sessions.get(file) === s) {
        const more = await withSession(file, (cur) => (cur === s && cur.media === m ? mediaBackStep(cur, m) : false));
        if (!more) break;
        await yieldNow();
      }
    } finally {
      m.running = false;
    }
  }

  async function mediaPage(s: Session, m: MediaIndex, kind: "images" | "links", cursor: MediaCursor | null, limit: number): Promise<MediaPage> {
    const progress = m.complete || s.scannedTo === 0 ? 1 : Math.min(1, Math.max(0, (s.scannedTo - m.oldestOffset) / s.scannedTo));
    // The open (last) exchange is read again every time (incrementally): it may still be growing.
    const open = s.starts.length - 1;
    const openEx = open >= 0 && s.starts[open]! >= m.newestOffset ? await openExchange(s) : null;
    const scratch: MediaIndex = { images: [], byPath: new Map(), links: new Map(), oldestOffset: 0, newestOffset: 0, complete: true, running: false };
    if (openEx) addMedia(s, scratch, openEx, s.starts[open]!, "newer", false);
    if (kind === "images") {
      const openPaths = new Set(scratch.images.filter((x) => x.path).map((x) => pathKey(x.path!)));
      const all = scratch.images.concat(m.images.filter((x) => !(x.path && openPaths.has(pathKey(x.path))))).slice(0, MAX_MEDIA);
      for (const x of scratch.images) if (x.path && all.includes(x)) addPath(s, x.path);
      const from = cursor ? all.findIndex((x) => imageOlder(x, cursor.o, cursor.q)) : 0;
      const images = from < 0 ? [] : all.slice(from, from + limit);
      const last = images.at(-1);
      const more = from >= 0 && from + limit < all.length;
      // While older exchanges are still being indexed, the end of a page is not the end: the cursor lets the window ask again.
      const next = last && (more || !m.complete) ? { e: s.epoch, o: last.offset, q: last.seq } : !last && cursor && !m.complete ? cursor : null;
      return { images, next, progress, complete: m.complete, epoch: s.epoch, total: all.length };
    }
    const merged = new Map(m.links);
    for (const l of scratch.links.values()) {
      const known = merged.get(l.norm);
      merged.set(l.norm, known ? { ...known, count: known.count + l.count, lastOffset: l.lastOffset, lastSeq: l.lastSeq } : l);
    }
    // Sorted by the first mention, newest first: a later mention of a link never moves it, so paging never skips it.
    const all = [...merged.values()].sort(linkBefore).slice(0, MAX_LINKS);
    const from = cursor ? all.findIndex((x) => linkBefore(x, { firstOffset: cursor.o, firstSeq: cursor.q, norm: cursor.n ?? "" } as MediaLink) > 0) : 0;
    const links = from < 0 ? [] : all.slice(from, from + limit);
    const last = links.at(-1);
    const more = from >= 0 && from + limit < all.length;
    const next = last && (more || !m.complete) ? { e: s.epoch, o: last.firstOffset, q: last.firstSeq, n: last.norm } : !last && cursor && !m.complete ? cursor : null;
    return { links, next, progress, complete: m.complete, epoch: s.epoch, total: all.length };
  }

  async function page(s: Session, end: number, n: number): Promise<Page> {
    const k = lastTurnsStart((i) => s.queued[i] === true, end, n);
    const exchanges = await exchangesOf(s, k, end);
    notePaths(s, exchanges);
    const hasMore = k > 0 || canExtend(s);
    return { exchanges, hasMore, oldestId: s.ids[k] ?? null, epoch: s.epoch, ...(!hasMore && s.truncated ? { truncated: true } : {}) };
  }

  return {
    /** The latest n turns (queued follow-ups included). Null: the file cannot be read. */
    tail(file: string, n: number): Promise<Page | null> {
      return withSession(file, async (s) => {
        await ensureBefore(s, null, n);
        return page(s, s.starts.length, n);
      });
    },

    /** The n turns that end right before exchange `id`, oldest first. "unknown": no such exchange in this file. */
    before(file: string, id: string, n: number): Promise<Page | "unknown" | null> {
      return withSession(file, async (s): Promise<Page | "unknown"> => {
        if ((await find(s, id)) < 0) return "unknown";
        const p = await ensureBefore(s, id, n);
        if (p <= 0) {
          return { exchanges: [], hasMore: false, oldestId: s.ids[0] ?? null, epoch: s.epoch, ...(s.truncated ? { truncated: true } : {}) };
        }
        return page(s, p, n);
      });
    },

    /** One exchange of the file, by id (indexing backwards as far as needed). */
    exchange(file: string, id: string): Promise<Exchange | null> {
      return withSession(file, async (s) => {
        const p = await find(s, id);
        return p < 0 ? null : ((await exchangesOf(s, p, p + 1))[0] ?? null);
      });
    },

    /**
     * A page of the session's images or links, newest first, from what the media index has so far; older exchanges
     * keep being indexed in the background. "stale": the cursor belongs to an earlier epoch of the file.
     */
    media(file: string, req: { kind: "images" | "links"; cursor: MediaCursor | null; limit: number }): Promise<MediaPage | "stale" | null> {
      return withSession(file, async (s): Promise<MediaPage | "stale"> => {
        if (req.cursor && req.cursor.e !== s.epoch) return "stale";
        const m = mediaOf(s);
        await mediaForward(s, m);
        // A first look gets a little of the history at once; the rest follows in the background.
        for (let i = 0; i < MEDIA_SYNC_STEPS && !m.complete && (req.kind === "images" ? m.images.length : m.links.size) < req.limit; i++) {
          if (!(await mediaBackStep(s, m))) break;
        }
        const out = await mediaPage(s, m, req.kind, req.cursor, req.limit);
        if (!m.complete) void runMedia(file, s, m);
        return out;
      });
    },

    /** The paths of every exchange this index has handed out for the file (the window may show them). */
    paths(file: string): ReadonlySet<string> {
      return sessions.get(file)?.paths ?? new Set();
    },

    /** For tests and diagnostics. */
    stats(file?: string) {
      const s = file ? sessions.get(file) : undefined;
      return {
        sessions: sessions.size,
        ...(s ? { exchanges: s.starts.length, coveredFrom: s.coveredFrom, scannedTo: s.scannedTo, truncated: s.truncated, epoch: s.epoch, cached: s.parsed.size, cachedCost: s.parsedCost } : {}),
      };
    },
  };
}

export type History = ReturnType<typeof createHistory>;
