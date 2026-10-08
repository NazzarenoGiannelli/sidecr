import type { Activity } from "../src/server";

/** What the server reports while a pane is working (see GET /api/conversation). Every field is untrusted text or numbers. */
export type { Activity };

const DAY_MS = 24 * 3600_000;

/** `12s`, `1m 44s`, `1h 2m 3s`. Floored; never negative. */
export function formatElapsed(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// One decimal under 10, whole numbers from 10 up.
const roundStep = (x: number) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
const showStep = (r: number) => (r < 10 ? r.toFixed(1) : String(r));

/** `950`, `9.0k`, `12k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1e6) {
    const k = roundStep(n / 1000);
    if (k < 1000) return `${showStep(k)}k`; // 999.9k rounds up to 1000k: that is 1.0M, below
  }
  return `${showStep(roundStep(n / 1e6))}M`;
}

/**
 * Seconds the pane has been working, as of nowMs, or null when there is nothing trustworthy to show.
 * A screen reading gives elapsedSec as of the moment the payload arrived (receivedAtMs); a transcript
 * reading only gives the time of the last user message.
 */
export function elapsedNow(a: Activity, receivedAtMs: number, nowMs: number): number | null {
  if (typeof a.elapsedSec === "number" && Number.isFinite(a.elapsedSec)) {
    return a.elapsedSec + (nowMs - receivedAtMs) / 1000;
  }
  if (typeof a.startedAt !== "string") return null;
  const started = Date.parse(a.startedAt);
  if (!Number.isFinite(started)) return null;
  const ms = nowMs - started;
  if (ms < 0 || ms > DAY_MS) return null;
  return ms / 1000;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The pieces of the activity row, in order: the verb (always), the elapsed time if known, then the detail or the output token count. */
export function activityParts(a: Activity, receivedAtMs: number, nowMs: number): string[] {
  const parts = [text(a.verb) || "Working"];
  const elapsed = elapsedNow(a, receivedAtMs, nowMs);
  if (elapsed !== null) parts.push(formatElapsed(elapsed));
  const detail = text(a.detail);
  if (detail) parts.push(detail);
  else if (a.tokens && typeof a.tokens.output === "number" && a.tokens.output > 0) parts.push(`↓ ${formatTokens(a.tokens.output)} tokens`);
  return parts;
}
