import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectPaths, expandHome, looksLikeDirectory, tokenize } from "../src/links";
import { parseInline } from "../ui/markdown";
import { budget } from "./timing";

/** [value, isDirectoryCandidate] of every path token. */
const paths = (s: string) => tokenize(s).filter((t) => t.type === "path").map((t) => [t.value, t.dir === true] as const);

describe("looksLikeDirectory", () => {
  test("a last segment without an extension, or a trailing separator, may be a folder", () => {
    for (const p of ["C:\\Users\\x\\folder", "/home/x/folder", "~/folder", "C:\\a\\.claude", "/home/x/.config", "C:\\a\\shot(1)", "/opt/node-v20.11.1", "/a/v1.2", "C:\\a\\b\\", "/a/my.project/", "C:/a/my.project/"]) {
      expect(looksLikeDirectory(p), p).toBe(true);
    }
  });
  test("a last segment with an extension is a file", () => {
    for (const p of ["C:\\a\\notes.md", "/a/b.PNG", "~/x.tar.gz", "/a/run.exe", "/a/my.project", "/a/page.html", "/a/clip.mp4", "/a/a.7z", "/a/f.docx"]) {
      expect(looksLikeDirectory(p), p).toBe(false);
    }
  });
  test("a dot in an earlier segment does not make the last one a file", () => {
    expect(looksLikeDirectory("C:\\a.b\\folder")).toBe(true);
    expect(looksLikeDirectory("/a.b/folder")).toBe(true);
    expect(looksLikeDirectory("/a.b/folder.txt")).toBe(false);
  });
  test("degenerate input", () => {
    expect(looksLikeDirectory("")).toBe(false);
    expect(looksLikeDirectory("/a/..")).toBe(true);
    expect(looksLikeDirectory("/a/b.")).toBe(true);
    expect(looksLikeDirectory("/a/b.é")).toBe(true);
    expect(looksLikeDirectory("/a/b.abcdefghijk")).toBe(true); // 11 characters: not an extension
  });
});

describe("tokenize: folder candidates", () => {
  test("Windows folders with backslashes and with forward slashes", () => {
    expect(paths("saved in C:\\Users\\x\\folder now")).toEqual([["C:\\Users\\x\\folder", true]]);
    expect(paths("saved in C:/Users/x/folder now")).toEqual([["C:/Users/x/folder", true]]);
    expect(paths("see c:/users/x")).toEqual([["c:/users/x", true]]);
  });
  test("POSIX and home folders", () => {
    expect(paths("in /home/x/folder and ~/folder")).toEqual([["/home/x/folder", true], ["~/folder", true]]);
  });
  test("a trailing separator is part of the link, with or without sentence punctuation after it", () => {
    expect(paths("C:\\Users\\x\\folder\\ ok")).toEqual([["C:\\Users\\x\\folder\\", true]]);
    expect(paths("C:/Users/x/folder/ ok")).toEqual([["C:/Users/x/folder/", true]]);
    expect(paths("in /home/x/folder/ ok")).toEqual([["/home/x/folder/", true]]);
    expect(paths("in ~/folder/, then")).toEqual([["~/folder/", true]]);
    expect(paths("(see /home/x/folder/)")).toEqual([["/home/x/folder/", true]]);
    expect(paths("see /home/x/folder/.")).toEqual([["/home/x/folder/", true]]);
    expect(paths("see C:\\Users\\x\\folder.")).toEqual([["C:\\Users\\x\\folder", true]]);
  });
  test("inside backticks and markdown", () => {
    expect(tokenize("`C:\\Users\\x\\folder`").map((t) => [t.type, t.value])).toEqual([["text", "`"], ["path", "C:\\Users\\x\\folder"], ["text", "`"]]);
    expect(paths("**/home/x/folder**")).toEqual([["/home/x/folder", true]]);
    expect(paths("[x](/home/x/folder)")).toEqual([["/home/x/folder", true]]);
    // the markdown parser keeps the path literal: `\.` in a dot folder is not an escape, `__init__` is not bold
    expect(parseInline("C:\\Users\\x\\.claude")).toEqual([{ t: "text", v: "C:\\Users\\x\\.claude" }]);
    expect(parseInline("/pkg/__init__/")).toEqual([{ t: "text", v: "/pkg/__init__/" }]);
  });
  test("non-ASCII folder names are one path, not cut at the first accent", () => {
    expect(paths("in ~/Documenti/Città e /home/x/Música ok")).toEqual([["~/Documenti/Città", true], ["/home/x/Música", true]]);
    expect(paths("C:\\Users\\Zoë\\Música")).toEqual([["C:\\Users\\Zoë\\Música", true]]);
  });
  test("a single POSIX word or a slash command is not linked, two segments are", () => {
    expect(paths("the /api and /tmp and /morning words")).toEqual([]);
    expect(paths("GET /api/users")).toEqual([["/api/users", true]]);
    expect(paths("and/or 10/12 a/b http://x.dev")).toEqual([]);
  });
  test("a bare drive or filesystem root is never a candidate", () => {
    expect(paths("open C:\\ or C:/ or / or ~/ or ~")).toEqual([]);
  });
  test("files stay files", () => {
    expect(paths("C:\\a\\b.png /a/b.md ~/x.txt C:/a/b.pdf")).toEqual([["C:\\a\\b.png", false], ["/a/b.md", false], ["~/x.txt", false], ["C:/a/b.pdf", false]]);
    expect(paths("open /notes.md")).toEqual([["/notes.md", false]]);
  });
  test("URLs and file: URLs do not produce folder candidates", () => {
    expect(paths("see https://example.com/a/b/c/ and https://x.dev/a/b")).toEqual([]);
    expect(paths("file:///C:/Users/x/folder")).toEqual([]);
    expect(paths("file:///home/x/folder")).toEqual([]);
    expect(paths("etc:/a/b and word:/x/y")).toEqual([]);
  });
  test("paths with a drive letter after a word character are still not drives", () => {
    expect(paths("plan_C:/a/b")).toEqual([]);
  });
  test("what was tokenised joins back to the text", () => {
    for (const s of ["a C:\\x\\y\\ b /home/x/z/ c ~/q d C:/m/n e", "`C:\\Users\\x\\folder\\` and (~/folder/)", "x /a/b/ y"]) {
      expect(tokenize(s).map((t) => t.value).join("")).toBe(s);
    }
  });
});

describe("collectPaths: folder candidates reach the allow-list", () => {
  const ex = (assistant: string, user = "") => [{
    id: "1",
    user: user ? [{ kind: "text" as const, text: user }] : [],
    assistant: [{ kind: "text" as const, text: assistant }, { kind: "tools" as const, count: 1, items: [] }],
  }];
  test("folders and files from both sides, with ~/ expanded", () => {
    const found = collectPaths(ex("saved in C:\\out\\run1 and /tmp/out/run2/ with /tmp/out/a.png", "look in ~/Documents/x")).sort();
    expect(found).toEqual([join(homedir(), "Documents/x"), "/tmp/out/a.png", "/tmp/out/run2/", "C:\\out\\run1"].sort());
  });
  test("a trailing separator survives the expansion of ~", () => {
    expect(collectPaths(ex("in ~/my.project/"))).toEqual([expandHome("~/my.project/")]);
    expect(looksLikeDirectory(expandHome("~/my.project/"))).toBe(true);
  });
  test("a bare slash word is not collected", () => {
    expect(collectPaths(ex("use /api or /tmp"))).toEqual([]);
  });
});

describe("tokenize: linear time on adversarial input", () => {
  const SIZE = 200_000;
  const hostile = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const units: [string, string][] = [
    ["drive and backslashes", "C:\\a\\"],
    ["drive and slashes", "C:/a/"],
    ["drives chained", "a:/b:\\"],
    ["slash segments", "/a"],
    ["slash segments with trailing separator", "/a/"],
    ["double slashes", "//"],
    ["tildes", "~/"],
    ["tilde runs", "~"],
    ["backslash runs", "\\"],
    ["dots", "/."],
    ["accents", "/é"],
    ["combining marks", "/e\u0301"],
    ["file: roots", "file:///C:/"],
    ["backticks", "`/a/b`"],
    ["parentheses", "/a(("],
  ];
  test.each(units)("%s repeated finishes in under 250 ms and keeps the text whole", (_name, unit) => {
    const s = hostile(unit);
    const start = performance.now();
    const tokens = tokenize(s);
    expect(performance.now() - start).toBeLessThan(budget(250));
    expect(tokens.map((t) => t.value).join("")).toBe(s);
  });
  describe("a path followed by a long run of closing brackets (the trailing-bracket trim is one pass)", () => {
    const heads = ["C:\\a", "C:/a", " C:/a", "C:\\a\\b", "/a/b", "~/a", "C:\\a(b"];
    const runs: [string, string][] = [
      ["parentheses", ")"],
      ["square brackets", "]"],
      ["curly braces", "}"],
      ["parentheses and square brackets", ")]"],
      ["mixed with dots", ").]"],
      ["opening and closing", "()"],
      ["braces and parentheses", "})"],
    ];
    for (const head of heads) {
      test.each(runs)(`${JSON.stringify(head)} followed by %s`, (_name, unit) => {
        const s = head + unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
        const start = performance.now();
        const tokens = tokenize(s);
        expect(performance.now() - start).toBeLessThan(budget(250));
        expect(tokens.map((t) => t.value).join("")).toBe(s);
      });
    }
    test("the trim still keeps balanced brackets and drops the unbalanced ones", () => {
      expect(paths("C:\\a\\shot(1)")).toEqual([["C:\\a\\shot(1)", true]]);
      expect(paths("(see C:\\a\\b)")).toEqual([["C:\\a\\b", true]]);
      expect(paths("C:\\a\\x(1))")).toEqual([["C:\\a\\x(1)", true]]);
      expect(paths("[C:\\a\\b]")).toEqual([["C:\\a\\b", true]]);
      expect(paths("C:\\a\\b[1]]")).toEqual([["C:\\a\\b[1]", true]]);
      expect(paths("C:\\a\\b).,")).toEqual([["C:\\a\\b", true]]);
    });
  });
  test("looksLikeDirectory on a very long last segment", () => {
    const t = performance.now();
    looksLikeDirectory("/a/" + "x.".repeat(SIZE / 2));
    looksLikeDirectory("C:\\a\\" + ".".repeat(SIZE));
    expect(performance.now() - t).toBeLessThan(budget(250));
  });
  test("collectPaths on a long text keeps the cost of the tokenizer", () => {
    const s = hostile("C:\\Users\\x\\folder\\ ");
    const t = performance.now();
    const found = collectPaths([{ id: "1", user: [], assistant: [{ kind: "text", text: s }] }]);
    expect(performance.now() - t).toBeLessThan(budget(500));
    expect(found).toContain("C:\\Users\\x\\folder\\"); // the cut-off last repetition is a second, shorter entry
    expect(found.length).toBeLessThanOrEqual(2);
  });
});
