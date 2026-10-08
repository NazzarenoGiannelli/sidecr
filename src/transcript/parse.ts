export interface ToolItem {
  name: string;
  summary: string;
}

export type Block =
  | { kind: "text"; text: string }
  | { kind: "tools"; count: number; items: ToolItem[] }
  | { kind: "image"; dataUrl: string };

export interface Exchange {
  id: string;
  user: Block[];
  assistant: Block[];
  /** The `timestamp` of the user row that began the exchange. */
  startedAt?: string;
  /** Tokens used by the assistant turns of this exchange; absent until the first assistant row. */
  tokens?: { input: number; output: number };
  /** The user sent this while Claude was working; Claude Code recorded it as a queued_command attachment. */
  queued?: boolean;
}

/**
 * The trailing run of displayed exchanges that is one turn of work: the last exchange plus the ones before it for as long
 * as the later one was queued. startedAt is the first one's, tokens are summed. A queued message does not restart the clock.
 */
export function turnOf(exchanges: Exchange[]): { startedAt?: string; tokens?: { input: number; output: number } } {
  let first = exchanges.length - 1;
  if (first < 0) return {};
  while (first > 0 && exchanges[first]!.queued) first--;
  let tokens: { input: number; output: number } | undefined;
  for (let i = first; i < exchanges.length; i++) {
    const t = exchanges[i]!.tokens;
    if (!t) continue;
    tokens = { input: (tokens?.input ?? 0) + t.input, output: (tokens?.output ?? 0) + t.output };
  }
  const startedAt = exchanges[first]!.startedAt;
  return { ...(startedAt ? { startedAt } : {}), ...(tokens ? { tokens } : {}) };
}

const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
// Transcript content is untrusted and ends up in a data URL in the browser: validate at this boundary.
const IMAGE_MEDIA_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const BASE64_DATA = /^[A-Za-z0-9+/=]+$/;
const MAX_TOOL_ITEMS = 40;
const MAX_SUMMARY_CHARS = 160;
const MAX_TOOL_NAME_CHARS = 60;
/** How many rows after a queued message its twin (the other record of the same message) is looked for. */
export const QUEUED_TWIN_ROWS = 50;
/** Opening tags of text the harness injects; a queued prompt that starts with one is not the user's message. */
const HARNESS_TAGS = ["<agent-message", "<task-notification", "<system-reminder"];

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function oneLine(text: string): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : flat;
}

/** One line describing what a tool call did, from its input. Transcript content is untrusted: only strings are used. */
function toolSummary(name: string, input: unknown): string {
  const o: Record<string, unknown> = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  let raw: string | undefined;
  switch (name) {
    case "Bash":
      raw = str(o.command);
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      raw = str(o.file_path);
      break;
    case "NotebookEdit":
      raw = str(o.notebook_path) ?? str(o.file_path);
      break;
    case "Grep": {
      const pattern = str(o.pattern);
      const path = str(o.path);
      raw = pattern !== undefined && path ? `${pattern} in ${path}` : pattern;
      break;
    }
    case "Glob":
      raw = str(o.pattern);
      break;
    case "WebFetch":
      raw = str(o.url);
      break;
    case "WebSearch":
      raw = str(o.query);
      break;
    case "Agent":
    case "Task":
      raw = str(o.description);
      break;
    case "TodoWrite":
      raw = "todo list";
      break;
    default:
      raw = Object.values(o).find((v): v is string => typeof v === "string");
  }
  return oneLine(raw ?? "");
}

/**
 * Claude Code stores pasted or dictated text as <pasted_content id="cbd4">...</pasted_content id="cbd4">
 * (the closing tag repeats the id, which is not valid XML). It is the user's own text: only the two tags go.
 * Every part is bounded (an id is at most 64 characters), so a long run of odd input cannot make it slow.
 */
const PASTED_CONTENT_TAG = /<\/?pasted_content(?:\s+id="?[A-Za-z0-9_-]{1,64}"?)?\s*>/g;

const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;

export function cleanUserText(text: string): string {
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return args ? `${cmd[1]} ${args}` : cmd[1];
  }
  if (/^\s*<local-command-/.test(text)) return "";
  const cleaned = text.replace(PASTED_CONTENT_TAG, "").trim();
  // Claude Code records Esc / Stop as a user row with this text: the harness's, not something the user typed.
  return INTERRUPT_MARKER.test(cleaned) ? "" : cleaned;
}

/** null means "not a human prompt" (a tool result), so it must not start an exchange. */
function userBlocks(content: unknown): Block[] | null {
  if (typeof content === "string") {
    const text = cleanUserText(content);
    return text ? [{ kind: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  if (content.length > 0 && content.every((b) => b?.type === "tool_result")) return null;
  const blocks: Block[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") {
      const text = cleanUserText(b.text);
      if (text) blocks.push({ kind: "text", text });
    } else if (b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string") {
      if (!IMAGE_MEDIA_TYPE.test(String(b.source.media_type)) || !BASE64_DATA.test(b.source.data)) {
        blocks.push({ kind: "text", text: "[image not shown: unsupported data]" });
      } else if (b.source.data.length * 0.75 > MAX_INLINE_IMAGE_BYTES) {
        blocks.push({ kind: "text", text: "[image too large to preview]" });
      } else {
        blocks.push({ kind: "image", dataUrl: `data:${b.source.media_type};base64,${b.source.data}` });
      }
    }
  }
  return blocks;
}

/** A usage count from the transcript: only a finite, non-negative number counts. */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * What the queued-twin check remembers between rows. A message sent while Claude works is recorded as an attachment
 * row and, sometimes later, again as a user row (promptSource "queued"). These lists remember the texts of the two
 * kinds so the second record does not show twice. `at` is the row's line number.
 */
export interface TwinState {
  fromAttachments: { text: string; at: number }[];
  fromQueuedUserRows: { text: string; at: number }[];
}

export const newTwinState = (): TwinState => ({ fromAttachments: [], fromQueuedUserRows: [] });

function takeTwin(list: { text: string; at: number }[], text: string, at: number): boolean {
  for (let i = list.length - 1; i >= 0; i--) if (at - list[i]!.at > QUEUED_TWIN_ROWS) list.splice(i, 1);
  const hit = list.findIndex((e) => e.text === text);
  if (hit < 0) return false;
  list.splice(hit, 1);
  return true;
}

/** A row that begins an exchange: the user's blocks, whether it was queued, and the row's own uuid and timestamp. */
export interface ExchangeStart {
  /** The row's raw uuid (anything; the caller turns it into an id). */
  uuid: unknown;
  user: Block[];
  queued: boolean;
  /** The row's own timestamp, when it is a string. */
  ts?: string;
}

/** Rows that never count: side chains, meta rows, compaction summaries, and anything that is not an object. */
export const isIgnoredRow = (row: any): boolean => !row || typeof row !== "object" || row.isSidechain || row.isMeta || row.isCompactSummary;

/**
 * Whether a parsed row begins an exchange (a human prompt, or a message queued while Claude worked), and with what.
 * Updates the twin state, so it must see the rows in order. The same row seen with a fresh state is still a start
 * (the twin check can only take starts away): that is how a known start is re-read later (src/transcript/history.ts).
 */
export function exchangeStart(row: any, twins: TwinState, at: number): ExchangeStart | null {
  if (isIgnoredRow(row)) return null;
  const ts = typeof row.timestamp === "string" ? row.timestamp : undefined;
  if (row.type === "attachment") {
    if (row.attachment?.type !== "queued_command" || typeof row.attachment.prompt !== "string") return null;
    // Only the user's own messages: a background task or monitor event arrives the same way, as another commandMode.
    const mode = row.attachment.commandMode;
    if (mode !== undefined && mode !== "prompt") return null;
    const text = cleanUserText(row.attachment.prompt);
    if (!text) return null;
    // A peer message or a harness reminder can arrive through the queue as a prompt: not something the user typed.
    if (HARNESS_TAGS.some((tag) => text.startsWith(tag))) return null; // cleanUserText already trimmed the leading whitespace
    if (takeTwin(twins.fromQueuedUserRows, text, at)) return null; // the user row came first and already shows it
    twins.fromAttachments.push({ text, at });
    return { uuid: row.uuid, user: [{ kind: "text", text }], queued: true, ...(ts ? { ts } : {}) };
  }
  if (row.type === "user") {
    // A finished background task, a peer message: only a human origin (or none, in older transcripts) is the user.
    const origin = row.origin;
    if (origin && typeof origin === "object" && origin.kind !== undefined && origin.kind !== "human") return null;
    const blocks = userBlocks(row.message?.content);
    if (!blocks || blocks.length === 0) return null;
    const only = blocks.length === 1 && blocks[0]!.kind === "text" ? blocks[0]!.text : null;
    // Only a queued twin is a duplicate: the same text typed again is a message of its own.
    if (only !== null && row.promptSource === "queued" && takeTwin(twins.fromAttachments, only, at)) return null;
    if (only !== null && row.promptSource === "queued") twins.fromQueuedUserRows.push({ text: only, at });
    return { uuid: row.uuid, user: blocks, queued: false, ...(ts ? { ts } : {}) };
  }
  return null;
}

/** Per exchange: the last usage of each assistant message id (one message can span several rows). */
export type Usage = Map<Exchange, Map<string, { input: number; output: number }>>;

/** Adds an assistant row to the exchange it belongs to (the latest one): its text, tool calls and usage. */
export function addAssistantRow(current: Exchange, row: any, usage: Usage): void {
  const perId = usage.get(current) ?? new Map<string, { input: number; output: number }>();
  usage.set(current, perId);
  const messageId = typeof row.message?.id === "string" ? row.message.id : `row ${perId.size}`;
  perId.set(messageId, { input: count(row.message?.usage?.input_tokens), output: count(row.message?.usage?.output_tokens) });
  const content = Array.isArray(row.message?.content) ? row.message.content : [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      current.assistant.push({ kind: "text", text: b.text });
    } else if (b?.type === "tool_use") {
      const name = str(b.name) ?? "";
      const shown = name.length > MAX_TOOL_NAME_CHARS ? `${name.slice(0, MAX_TOOL_NAME_CHARS - 1)}…` : name;
      const item: ToolItem = { name: shown, summary: toolSummary(name, b.input) };
      let last = current.assistant.at(-1);
      if (last?.kind !== "tools") {
        last = { kind: "tools", count: 0, items: [] };
        current.assistant.push(last);
      }
      last.count += 1;
      if (last.items.length < MAX_TOOL_ITEMS) last.items.push(item);
    }
  }
}

/** Sums each exchange's usage once (an exchange with no assistant row gets no tokens). */
export function finishTokens(exchanges: Exchange[], usage: Usage): void {
  for (const e of exchanges) {
    const perId = usage.get(e);
    if (!perId) continue;
    const total = { input: 0, output: 0 };
    for (const u of perId.values()) {
      total.input += u.input;
      total.output += u.output;
    }
    e.tokens = total;
  }
}

export function parseTranscript(lines: string[], n: number): Exchange[] {
  const exchanges: Exchange[] = [];
  const usage: Usage = new Map();
  const twins = newTwinState();
  for (const [at, line] of lines.entries()) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isIgnoredRow(row)) continue;
    if (row.type === "assistant") {
      const current = exchanges.at(-1);
      if (current) addAssistantRow(current, row, usage);
      continue;
    }
    const start = exchangeStart(row, twins, at);
    if (!start) continue;
    const exchange: Exchange = { id: String(start.uuid ?? exchanges.length), user: start.user, assistant: [] };
    if (start.queued) {
      exchange.queued = true;
      // Same turn as the work in progress: the clock keeps running from when that turn began.
      const startedAt = exchanges.at(-1)?.startedAt ?? start.ts;
      if (startedAt) exchange.startedAt = startedAt;
    } else if (start.ts) exchange.startedAt = start.ts;
    exchanges.push(exchange);
  }
  // Tokens for every exchange before the window is cut: a turn's total spans its queued follow-ups.
  finishTokens(exchanges, usage);
  return lastTurns(exchanges, n);
}

/** Real prompts in `exchanges` (queued ones are follow-ups of a turn, not turns of their own). */
export const promptCount = (exchanges: Exchange[]): number => exchanges.reduce((c, e) => c + (e.queued ? 0 : 1), 0);

/**
 * Where the last `n` turns begin: the index of the n-th exchange from the end that is not queued (queued ones are
 * follow-ups of a turn). 0 when there are fewer than n real prompts; `length` when n <= 0.
 */
export function lastTurnsStart(queued: (i: number) => boolean, length: number, n: number): number {
  if (n <= 0) return length;
  let seen = 0;
  for (let i = length - 1; i >= 0; i--) {
    if (queued(i)) continue;
    if (++seen === n) return i;
  }
  return 0; // fewer real prompts than n: all of it
}

/** The last `n` exchanges that are not queued, plus every queued exchange after the first of them. */
function lastTurns(exchanges: Exchange[], n: number): Exchange[] {
  return exchanges.slice(lastTurnsStart((i) => exchanges[i]!.queued === true, exchanges.length, n));
}
