import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentsDirOf, buildMessage, hasWhitespace, pruneOld, saveAttachment, sanitizeName } from "../src/attachments";

const tmp = () => mkdtempSync(join(tmpdir(), "sidecr-"));

describe("sanitizeName", () => {
  test("keeps a normal name", () => expect(sanitizeName("shot 1.png")).toBe("shot-1.png"));
  test("strips path separators and traversal", () => {
    expect(sanitizeName("..\\..\\x.png")).toBe("x.png");
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
  });
  test("avoids reserved device names", () => {
    expect(sanitizeName("con.png")).toBe("_con.png");
    expect(sanitizeName("NUL")).toBe("_NUL");
  });
  test("limits length and never returns empty", () => {
    expect(sanitizeName("a".repeat(300) + ".png").length).toBeLessThanOrEqual(80);
    expect(sanitizeName("...")).toBe("file");
    expect(sanitizeName("")).toBe("file");
  });
});

describe("saveAttachment", () => {
  test("writes inside the directory with a timestamp prefix", () => {
    const dir = tmp();
    const p = saveAttachment(dir, "..\\..\\evil.png", new Uint8Array([1, 2, 3]), new Date("2026-10-01T19:40:05Z"));
    expect(resolve(dirname(p))).toBe(resolve(dir));
    expect(basename(p)).toMatch(/^\d{8}-\d{6}-evil\.png$/);
    expect([...readFileSync(p)]).toEqual([1, 2, 3]);
  });
  test("two files with the same name do not overwrite each other", () => {
    const dir = tmp();
    const now = new Date("2026-10-01T19:40:05Z");
    const a = saveAttachment(dir, "a.png", new Uint8Array([1]), now);
    const b = saveAttachment(dir, "a.png", new Uint8Array([2]), now);
    expect(a).not.toBe(b);
    expect([...readFileSync(a)]).toEqual([1]);
    expect([...readFileSync(b)]).toEqual([2]);
  });
  test("creates the directory and returns an absolute path", () => {
    const dir = join(tmp(), "nested", "attachments");
    const p = saveAttachment(dir, "a.png", new Uint8Array([1]));
    expect(existsSync(p)).toBe(true);
    expect(resolve(p)).toBe(p);
  });
});

describe("buildMessage", () => {
  test("text then one @path per file on the same line", () => {
    expect(buildMessage("look", ["C:\\a.png", "C:\\b.png"])).toBe("look @C:\\a.png @C:\\b.png");
  });
  test("files only", () => expect(buildMessage("", ["/a.png"])).toBe("@/a.png"));
  test("text only is trimmed and keeps inner newlines", () => expect(buildMessage("  a\nb  ", [])).toBe("a\nb"));
  test("normalises CRLF", () => expect(buildMessage("a\r\nb", [])).toBe("a\nb"));
});

describe("pruneOld", () => {
  test("deletes only files older than the limit", () => {
    const dir = tmp();
    const oldFile = join(dir, "20260901-101500-old.png");
    const newFile = join(dir, "20260930-101500-new.png");
    writeFileSync(oldFile, "x");
    writeFileSync(newFile, "x");
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    utimesSync(oldFile, longAgo, longAgo);
    expect(pruneOld(dir, 7 * 24 * 3600 * 1000)).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });
  test("missing directory is not an error", () => {
    expect(pruneOld(join(tmp(), "nope"), 1000)).toBe(0);
  });
  test("only files Sidecr named are deleted: a folder set with SIDECR_ATTACHMENTS_DIR may hold other files", () => {
    const dir = tmp();
    const ours = join(dir, "20260901-101500-shot.png");
    const collided = join(dir, "2-20260901-101500-shot.png");
    const foreign = join(dir, "notes.txt");
    const lookalike = join(dir, "2026-09-01-report.pdf");
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    for (const f of [ours, collided, foreign, lookalike]) {
      writeFileSync(f, "x");
      utimesSync(f, longAgo, longAgo);
    }
    expect(pruneOld(dir, 7 * 24 * 3600 * 1000)).toBe(2);
    expect([existsSync(ours), existsSync(collided), existsSync(foreign), existsSync(lookalike)]).toEqual([false, false, true, true]);
  });
});

describe("attachmentsDirOf and hasWhitespace", () => {
  test("the state directory's attachments folder by default", () => {
    expect(attachmentsDirOf(join("s", "state"), {})).toBe(resolve(join("s", "state", "attachments")));
    expect(attachmentsDirOf(join("s", "state"), { SIDECR_ATTACHMENTS_DIR: "   " })).toBe(resolve(join("s", "state", "attachments")));
  });
  test("SIDECR_ATTACHMENTS_DIR overrides it, resolved to an absolute path", () => {
    const over = join(tmp(), "att");
    expect(attachmentsDirOf("ignored", { SIDECR_ATTACHMENTS_DIR: over })).toBe(resolve(over));
    expect(attachmentsDirOf("ignored", { SIDECR_ATTACHMENTS_DIR: ` ${over} ` })).toBe(resolve(over));
  });
  test("whitespace of any kind in the path is what Claude Code cannot take in an @mention", () => {
    expect(hasWhitespace("C:\\Users\\Jane Doe\\AppData")).toBe(true);
    expect(hasWhitespace("/home/alice/my\tfiles")).toBe(true);
    expect(hasWhitespace("/home/alice/\u00a0x")).toBe(true);
    expect(hasWhitespace("C:\\Users\\alice\\AppData\\Local")).toBe(false);
    expect(hasWhitespace("/home/alice/.config/sidecr")).toBe(false);
  });
});
