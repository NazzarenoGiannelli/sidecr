import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBounds, validateBounds, writeBounds } from "../src/window-bounds";

describe("validateBounds", () => {
  test("accepts good values", () => {
    expect(validateBounds({ x: 3226, y: 159, w: 520, h: 760 })).toEqual({ x: 3226, y: 159, w: 520, h: 760 });
  });
  test("accepts negative coordinates (a monitor left of the primary) and the edges of the range", () => {
    expect(validateBounds({ x: -1920, y: -10000, w: 300, h: 3000 })).toEqual({ x: -1920, y: -10000, w: 300, h: 3000 });
    expect(validateBounds({ x: 20000, y: 20000, w: 3000, h: 300 })).toEqual({ x: 20000, y: 20000, w: 3000, h: 300 });
  });
  test("rounds to integers", () => {
    expect(validateBounds({ x: 10.4, y: 10.6, w: 520.5, h: 759.49 })).toEqual({ x: 10, y: 11, w: 521, h: 759 });
  });
  test("rejects the Windows minimised sentinel", () => {
    expect(validateBounds({ x: -32000, y: -32000, w: 160, h: 28 })).toBeNull();
    expect(validateBounds({ x: -32000, y: 10, w: 520, h: 760 })).toBeNull();
  });
  test("rejects strings, NaN, Infinity and missing fields", () => {
    expect(validateBounds({ x: "10", y: 10, w: 520, h: 760 })).toBeNull();
    expect(validateBounds({ x: NaN, y: 10, w: 520, h: 760 })).toBeNull();
    expect(validateBounds({ x: 10, y: Infinity, w: 520, h: 760 })).toBeNull();
    expect(validateBounds({ x: 10, y: 10, w: 520 })).toBeNull();
    expect(validateBounds({})).toBeNull();
  });
  test("rejects non-objects", () => {
    expect(validateBounds(null)).toBeNull();
    expect(validateBounds(undefined)).toBeNull();
    expect(validateBounds("x")).toBeNull();
    expect(validateBounds(42)).toBeNull();
  });
  test("rejects a size that is too small or too big", () => {
    expect(validateBounds({ x: 0, y: 0, w: 299, h: 760 })).toBeNull();
    expect(validateBounds({ x: 0, y: 0, w: 520, h: 299 })).toBeNull();
    expect(validateBounds({ x: 0, y: 0, w: 3001, h: 760 })).toBeNull();
    expect(validateBounds({ x: 0, y: 0, w: 520, h: 3001 })).toBeNull();
  });
  test("rejects a position out of range", () => {
    expect(validateBounds({ x: -10001, y: 0, w: 520, h: 760 })).toBeNull();
    expect(validateBounds({ x: 0, y: 20001, w: 520, h: 760 })).toBeNull();
  });
});

describe("window.json", () => {
  test("write then read round trips and the file is private", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sidecr-wb-")), "nested", "state");
    writeBounds(dir, { x: -5, y: 7, w: 520, h: 760 });
    expect(readBounds(dir)).toEqual({ x: -5, y: 7, w: 520, h: 760 });
    expect(JSON.parse(readFileSync(join(dir, "window.json"), "utf8"))).toEqual({ x: -5, y: 7, w: 520, h: 760 });
    if (process.platform !== "win32") expect(statSync(join(dir, "window.json")).mode & 0o777).toBe(0o600);
  });
  test("a corrupt file gives null", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecr-wb-"));
    writeFileSync(join(dir, "window.json"), "{not json");
    expect(readBounds(dir)).toBeNull();
  });
  test("a file with invalid values gives null", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecr-wb-"));
    writeFileSync(join(dir, "window.json"), JSON.stringify({ x: -32000, y: -32000, w: 160, h: 28 }));
    expect(readBounds(dir)).toBeNull();
  });
  test("a missing file or directory gives null", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecr-wb-"));
    expect(readBounds(dir)).toBeNull();
    expect(existsSync(join(dir, "nope"))).toBe(false);
    expect(readBounds(join(dir, "nope"))).toBeNull();
  });
});
