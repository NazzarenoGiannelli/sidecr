import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SIZE_RANGE = [300, 3000] as const;
const POSITION_RANGE = [-10000, 20000] as const;

const inRange = (n: number, [lo, hi]: readonly [number, number]) => n >= lo && n <= hi;

/** A usable window placement, or null. Windows reports -32000 for a minimised window, which falls outside the range. */
export function validateBounds(raw: unknown): Bounds | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const nums: number[] = [];
  for (const key of ["x", "y", "w", "h"]) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    nums.push(Math.round(v));
  }
  const [x, y, w, h] = nums as [number, number, number, number];
  if (!inRange(w, SIZE_RANGE) || !inRange(h, SIZE_RANGE)) return null;
  if (!inRange(x, POSITION_RANGE) || !inRange(y, POSITION_RANGE)) return null;
  return { x, y, w, h };
}

export function readBounds(dir: string): Bounds | null {
  try {
    return validateBounds(JSON.parse(readFileSync(join(dir, "window.json"), "utf8")));
  } catch {
    return null; // missing or corrupt
  }
}

export function writeBounds(dir: string, b: Bounds): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "window.json"), JSON.stringify(b), { mode: 0o600 });
}
