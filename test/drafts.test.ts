import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftTooLongError, MAX_DRAFT_CHARS, MAX_DRAFTS, getDraft, setDraft } from "../src/drafts";

const fresh = () => mkdtempSync(join(tmpdir(), "sidecr-drafts-"));
const file = (dir: string) => join(dir, "drafts.json");

describe("drafts", () => {
  test("set then get", () => {
    const dir = fresh();
    setDraft(dir, "w1:p1", "half a thought\nsecond line ");
    expect(getDraft(dir, "w1:p1")).toBe("half a thought\nsecond line ");
    expect(getDraft(dir, "w1:p2")).toBe("");
  });

  test("the file holds { pane: { text, updatedAt } }", () => {
    const dir = fresh();
    setDraft(dir, "w1:p1", "hi", () => 1234);
    expect(JSON.parse(readFileSync(file(dir), "utf8"))).toEqual({ "w1:p1": { text: "hi", updatedAt: 1234 } });
  });

  test("setting again overwrites", () => {
    const dir = fresh();
    setDraft(dir, "p", "one");
    setDraft(dir, "p", "two");
    expect(getDraft(dir, "p")).toBe("two");
    expect(Object.keys(JSON.parse(readFileSync(file(dir), "utf8")))).toEqual(["p"]);
  });

  test("drafts of different panes do not touch each other", () => {
    const dir = fresh();
    setDraft(dir, "a", "A");
    setDraft(dir, "b", "B");
    setDraft(dir, "a", "A2");
    expect([getDraft(dir, "a"), getDraft(dir, "b")]).toEqual(["A2", "B"]);
  });

  test("empty or whitespace-only text deletes the entry", () => {
    const dir = fresh();
    setDraft(dir, "a", "A");
    setDraft(dir, "b", "B");
    setDraft(dir, "a", " \n\t ");
    expect(getDraft(dir, "a")).toBe("");
    expect(Object.keys(JSON.parse(readFileSync(file(dir), "utf8")))).toEqual(["b"]);
    setDraft(dir, "b", "");
    expect(getDraft(dir, "b")).toBe("");
  });

  test("clearing a draft that never existed writes nothing and does not throw", () => {
    const dir = fresh();
    expect(() => setDraft(dir, "ghost", "")).not.toThrow();
    expect(existsSync(file(dir))).toBe(false);
  });

  test("text over the limit throws a typed error and changes nothing", () => {
    const dir = fresh();
    setDraft(dir, "p", "keep");
    expect(() => setDraft(dir, "p", "x".repeat(MAX_DRAFT_CHARS + 1))).toThrow(DraftTooLongError);
    expect(getDraft(dir, "p")).toBe("keep");
    setDraft(dir, "p", "x".repeat(MAX_DRAFT_CHARS)); // exactly at the limit is fine
    expect(getDraft(dir, "p")).toHaveLength(MAX_DRAFT_CHARS);
  });

  test("oversize whitespace is refused too, not treated as a delete", () => {
    const dir = fresh();
    setDraft(dir, "p", "keep");
    expect(() => setDraft(dir, "p", " ".repeat(MAX_DRAFT_CHARS + 1))).toThrow(DraftTooLongError);
    expect(getDraft(dir, "p")).toBe("keep");
  });

  test("at most 50 entries: the oldest by updatedAt is evicted", () => {
    const dir = fresh();
    for (let i = 0; i < MAX_DRAFTS; i++) setDraft(dir, `p${i}`, `t${i}`, () => 1000 + i);
    setDraft(dir, "p0", "t0 again", () => 5000); // refreshing p0 makes p1 the oldest
    setDraft(dir, "new", "fresh", () => 6000);
    expect(Object.keys(JSON.parse(readFileSync(file(dir), "utf8")))).toHaveLength(MAX_DRAFTS);
    expect(getDraft(dir, "p1")).toBe("");
    expect(getDraft(dir, "p0")).toBe("t0 again");
    expect(getDraft(dir, "new")).toBe("fresh");
    expect(getDraft(dir, "p2")).toBe("t2");
    setDraft(dir, "newer", "x", () => 7000);
    expect(getDraft(dir, "p2")).toBe("");
  });

  test("the entry just written survives even when its clock is the oldest", () => {
    const dir = fresh();
    for (let i = 0; i < MAX_DRAFTS; i++) setDraft(dir, `p${i}`, "t", () => 1000 + i);
    setDraft(dir, "late", "kept", () => 1); // clock went backwards
    expect(getDraft(dir, "late")).toBe("kept");
    expect(Object.keys(JSON.parse(readFileSync(file(dir), "utf8")))).toHaveLength(MAX_DRAFTS);
  });

  test("a missing file reads as empty", () => {
    expect(getDraft(join(fresh(), "nowhere"), "p")).toBe("");
  });

  test("a corrupt file reads as empty and is replaced by the next write", () => {
    const dir = fresh();
    writeFileSync(file(dir), "{not json");
    expect(getDraft(dir, "p")).toBe("");
    setDraft(dir, "p", "ok");
    expect(getDraft(dir, "p")).toBe("ok");
  });

  test("a file of the wrong shape reads as empty; bad entries are ignored", () => {
    const dir = fresh();
    for (const raw of ["[]", "null", "42", '"s"']) {
      writeFileSync(file(dir), raw);
      expect(getDraft(dir, "p")).toBe("");
    }
    writeFileSync(file(dir), JSON.stringify({ p: { text: 5, updatedAt: 1 }, q: "x", r: { text: "good", updatedAt: 2 } }));
    expect([getDraft(dir, "p"), getDraft(dir, "q"), getDraft(dir, "r")]).toEqual(["", "", "good"]);
  });

  test("a pane id like __proto__ is just a key", () => {
    const dir = fresh();
    setDraft(dir, "__proto__", "odd");
    expect(getDraft(dir, "__proto__")).toBe("odd");
    expect(({} as Record<string, unknown>).text).toBeUndefined();
  });

  test("the write is atomic: no temporary file is left behind", () => {
    const dir = fresh();
    for (let i = 0; i < 5; i++) setDraft(dir, `p${i}`, `t${i}`);
    setDraft(dir, "p0", "");
    expect(readdirSync(dir)).toEqual(["drafts.json"]);
  });

  test("a failed write throws and leaves no temporary file", () => {
    const dir = fresh();
    setDraft(dir, "x", "y");
    // A directory in place of drafts.json cannot be replaced by rename: the write fails after the temp file exists.
    rmSync(file(dir));
    mkdirSync(file(dir));
    expect(() => setDraft(dir, "p", "new")).toThrow();
    expect(readdirSync(dir)).toEqual(["drafts.json"]);
  });

  describe("rename retry", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const realRename = renameSync;

    test("a rename that fails twice with EPERM then succeeds is retried with a wait each time", () => {
      const dir = fresh();
      let calls = 0;
      const waits: number[] = [];
      setDraft(dir, "p", "kept", () => 1, {
        rename: (a, b) => { if (++calls <= 2) throw err("EPERM"); realRename(a, b); },
        wait: (ms) => waits.push(ms),
      });
      expect(calls).toBe(3);
      expect(waits).toEqual([20, 20]);
      expect(getDraft(dir, "p")).toBe("kept");
      expect(readdirSync(dir)).toEqual(["drafts.json"]);
    });

    test("EACCES and EBUSY are retried too", () => {
      for (const code of ["EACCES", "EBUSY"]) {
        const dir = fresh();
        let calls = 0;
        setDraft(dir, "p", "x", () => 1, {
          rename: (a, b) => { if (++calls === 1) throw err(code); realRename(a, b); },
          wait: () => {},
        });
        expect(getDraft(dir, "p")).toBe("x");
      }
    });

    test("a rename that always fails: 1 try + 3 retries, the temp file is removed, the error is rethrown", () => {
      const dir = fresh();
      let calls = 0;
      expect(() =>
        setDraft(dir, "p", "x", () => 1, { rename: () => { calls++; throw err("EPERM"); }, wait: () => {} }),
      ).toThrow("EPERM");
      expect(calls).toBe(4);
      expect(readdirSync(dir)).toEqual([]);
    });

    test("another error code is not retried", () => {
      const dir = fresh();
      let calls = 0;
      const waits: number[] = [];
      expect(() =>
        setDraft(dir, "p", "x", () => 1, { rename: () => { calls++; throw err("ENOSPC"); }, wait: (ms) => waits.push(ms) }),
      ).toThrow("ENOSPC");
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
