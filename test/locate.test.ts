import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, findTranscript } from "../src/transcript/locate";

describe("encodeCwd", () => {
  test("windows path", () => {
    expect(encodeCwd("C:\\Users\\alice\\Documents\\Notes\\Garden")).toBe("C--Users-alice-Documents-Notes-Garden");
  });
  test("posix path", () => {
    expect(encodeCwd("/home/alice/Documents/Repos")).toBe("-home-alice-Documents-Repos");
  });
  test("spaces and dots", () => {
    expect(encodeCwd("C:\\My Repos\\a.b")).toBe("C--My-Repos-a-b");
  });
});

describe("findTranscript", () => {
  const id = "0f8e3c2a-5b71-4d2e-9a6c-1e2f3a4b5c6d";

  test("direct hit by encoded cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "sidecr-"));
    const dir = join(root, "C--Users-alice-Vault");
    mkdirSync(dir);
    writeFileSync(join(dir, `${id}.jsonl`), "");
    expect(findTranscript(id, "C:\\Users\\alice\\Vault", root)).toBe(join(dir, `${id}.jsonl`));
  });

  test("falls back to searching every project directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sidecr-"));
    const dir = join(root, "some-other-encoding");
    mkdirSync(dir);
    writeFileSync(join(dir, `${id}.jsonl`), "");
    expect(findTranscript(id, "C:\\Elsewhere", root)).toBe(join(dir, `${id}.jsonl`));
  });

  test("null when absent or root missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sidecr-"));
    expect(findTranscript(id, "C:\\x", root)).toBeNull();
    expect(findTranscript(id, "C:\\x", join(root, "nope"))).toBeNull();
  });
});
