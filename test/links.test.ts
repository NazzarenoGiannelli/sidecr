import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectPaths, expandHome, tokenize } from "../src/links";

const kinds = (s: string) => tokenize(s).map((t) => [t.type, t.value]);

describe("tokenize", () => {
  test("plain text is one token", () => {
    expect(kinds("nothing here")).toEqual([["text", "nothing here"]]);
  });
  test("url without trailing punctuation", () => {
    expect(kinds("see https://example.com/a?b=1.")).toEqual([
      ["text", "see "], ["url", "https://example.com/a?b=1"], ["text", "."],
    ]);
  });
  test("windows path after an @ mention", () => {
    expect(kinds("open @C:\\Users\\a\\b.png now")).toEqual([
      ["text", "open @"], ["path", "C:\\Users\\a\\b.png"], ["text", " now"],
    ]);
  });
  test("posix and home paths", () => {
    expect(kinds("a /home/alice/x.txt and ~/notes/y.md")).toEqual([
      ["text", "a "], ["path", "/home/alice/x.txt"], ["text", " and "], ["path", "~/notes/y.md"],
    ]);
  });
  test("words with a slash are not paths", () => {
    expect(kinds("and/or 10/12 a/b")).toEqual([["text", "and/or 10/12 a/b"]]);
  });
  test("path with spaces links only up to the first space and keeps the text", () => {
    const tokens = tokenize("C:\\Users\\My Name\\a.png ok");
    expect(tokens.map((t) => t.value).join("")).toBe("C:\\Users\\My Name\\a.png ok");
  });
  test("trailing sentence punctuation stays outside a path", () => {
    expect(kinds("see /home/a/b.txt.")).toEqual([["text", "see "], ["path", "/home/a/b.txt"], ["text", "."]]);
  });
});

describe("tokenize: trailing characters and single segments", () => {
  test("a windows path in parentheses does not swallow the closing bracket", () => {
    expect(kinds("(see C:\\a\\b.png)")).toEqual([["text", "(see "], ["path", "C:\\a\\b.png"], ["text", ")"]]);
  });
  test("a windows path followed by a bracket, quote or comma", () => {
    expect(kinds("[C:\\a\\b.png]")).toEqual([["text", "["], ["path", "C:\\a\\b.png"], ["text", "]"]]);
    expect(kinds("'C:\\a\\b.png'")).toEqual([["text", "'"], ["path", "C:\\a\\b.png"], ["text", "'"]]);
    expect(kinds("C:\\a\\b.png, then")).toEqual([["path", "C:\\a\\b.png"], ["text", ", then"]]);
  });
  test("balanced parentheses inside a windows path name stay", () => {
    expect(kinds("C:\\a\\shot(1)")).toEqual([["path", "C:\\a\\shot(1)"]]);
  });
  test("a single-segment slash word is plain text", () => {
    expect(kinds("run /morning then /review and /model.")).toEqual([["text", "run /morning then /review and /model."]]);
  });
  test("two segments, or one segment with a dot, are paths", () => {
    expect(kinds("cat /etc/hosts")).toEqual([["text", "cat "], ["path", "/etc/hosts"]]);
    expect(kinds("open /notes.md")).toEqual([["text", "open "], ["path", "/notes.md"]]);
  });
  test("home paths keep working with one segment", () => {
    expect(kinds("see ~/x")).toEqual([["text", "see "], ["path", "~/x"]]);
  });
});

describe("expandHome and collectPaths", () => {
  test("expands ~/", () => {
    expect(expandHome("~/x.md")).toBe(join(homedir(), "x.md"));
    expect(expandHome("/abs/x.md")).toBe("/abs/x.md");
  });
  test("collects paths from text blocks of both sides", () => {
    const ex = [{
      id: "1",
      user: [{ kind: "text" as const, text: "look @/tmp/a.png" }],
      assistant: [{ kind: "text" as const, text: "saw /tmp/b.png and https://x.dev" }, { kind: "tools" as const, count: 2, items: [] }],
    }];
    expect(collectPaths(ex).sort()).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });
});
