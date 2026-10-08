import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, type SaveDeps } from "./atomic-file";

export const MAX_DRAFT_CHARS = 20000;
export const MAX_DRAFTS = 50;

export class DraftTooLongError extends Error {
  constructor() {
    super(`a draft is limited to ${MAX_DRAFT_CHARS} characters`);
  }
}

interface Entry {
  text: string;
  updatedAt: number;
}

const FILE = "drafts.json";

/** The stored drafts in insertion order. A missing, corrupt or wrongly shaped file reads as empty. */
function load(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    for (const [pane, v] of Object.entries(raw)) {
      const e = v as Partial<Entry> | null;
      if (e && typeof e === "object" && typeof e.text === "string" && typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt)) {
        out.set(pane, { text: e.text, updatedAt: e.updatedAt });
      }
    }
  } catch {
    /* missing or corrupt */
  }
  return out;
}

export type { SaveDeps } from "./atomic-file";

/** Temp file in the same directory, then rename (see writeFileAtomic). */
function save(dir: string, drafts: Map<string, Entry>, deps: SaveDeps = {}): void {
  writeFileAtomic(dir, FILE, JSON.stringify(Object.fromEntries(drafts)), deps);
}

export function getDraft(dir: string, pane: string): string {
  return load(dir).get(pane)?.text ?? "";
}

/** Text that is only whitespace removes the draft. More than 20000 characters throws DraftTooLongError. */
export function setDraft(dir: string, pane: string, text: string, now: () => number = Date.now, deps: SaveDeps = {}): void {
  if (text.length > MAX_DRAFT_CHARS) throw new DraftTooLongError();
  const drafts = load(dir);
  if (text.trim() === "") {
    if (drafts.delete(pane)) save(dir, drafts, deps);
    return;
  }
  drafts.delete(pane); // re-added at the end: the draft just written is the newest, whatever the clock says
  drafts.set(pane, { text, updatedAt: now() });
  if (drafts.size > MAX_DRAFTS) {
    // Array.sort is stable, so equal timestamps keep their insertion order and the oldest write goes first.
    const oldestFirst = [...drafts.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of oldestFirst) {
      if (drafts.size <= MAX_DRAFTS) break;
      if (key !== pane) drafts.delete(key);
    }
  }
  save(dir, drafts, deps);
}
