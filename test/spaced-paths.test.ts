import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOKEN, collectPaths, expandHome, looksLikeDirectory, tokenize, tokenizeCode, tokenizeFenceBody, wholePathRange } from "../src/links";
import { createServer } from "../src/server";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { encodeCwd } from "../src/transcript/locate";
import { parseInline, parseMarkdown } from "../ui/markdown";
import { renderMarkdown } from "../ui/markdown-dom";
import { renderText } from "../ui/rich-text";
import { budget } from "./timing";

// Paths with spaces: an explicit delimiter (a code span, a quoted string, a line of a fenced block) tells where the path ends.

/** [value, isDirectoryCandidate] of every path token. */
const paths = (s: string) => tokenize(s).filter((t) => t.type === "path").map((t) => [t.value, t.dir === true] as const);
const values = (s: string) => paths(s).map(([v]) => v);

const SPACED = "C:\\Users\\alice\\Documents\\sidecr-click-test\\with spaces";
const ACCENT = "C:\\Users\\alice\\Documents\\sidecr-click-test\\città accentata";

describe("a code span whose whole content is a path", () => {
  test("Windows folder with spaces, and with a space and an accent", () => {
    expect(paths(`\`${SPACED}\``)).toEqual([[SPACED, true]]);
    expect(paths(`\`${ACCENT}\``)).toEqual([[ACCENT, true]]);
    expect(tokenize(`\`${SPACED}\``).map((t) => [t.type, t.value])).toEqual([["text", "`"], ["path", SPACED], ["text", "`"]]);
  });
  test("a file with spaces, a comma, parentheses and non-ASCII letters", () => {
    expect(paths("`C:\\My Docs\\Report, final (v2) è.pdf`")).toEqual([["C:\\My Docs\\Report, final (v2) è.pdf", false]]);
    expect(paths("`/home/x/My Docs/Report, final (v2) è.md`")).toEqual([["/home/x/My Docs/Report, final (v2) è.md", false]]);
  });
  test("Windows forward-slash form, POSIX and home forms", () => {
    expect(paths("`C:/Users/x/My Docs`")).toEqual([["C:/Users/x/My Docs", true]]);
    expect(paths("`/home/x/città accentata`")).toEqual([["/home/x/città accentata", true]]);
    expect(paths("`~/My Docs/notes.md`")).toEqual([["~/My Docs/notes.md", false]]);
    expect(paths("`~/My Docs`")).toEqual([["~/My Docs", true]]);
  });
  test("a trailing separator makes it a folder candidate, an extension a file", () => {
    expect(paths("`C:\\a b\\my.project\\`")).toEqual([["C:\\a b\\my.project\\", true]]);
    expect(paths("`/a b/my.project`")).toEqual([["/a b/my.project", false]]);
    expect(looksLikeDirectory("/a b/c d")).toBe(true);
  });
  test("double backticks, a triple run inline, and one space of padding", () => {
    expect(values("``C:\\a b\\c``")).toEqual(["C:\\a b\\c"]);
    expect(values("```C:\\a b\\c```")).toEqual(["C:\\a b\\c"]);
    expect(values("` C:\\a b\\c `")).toEqual(["C:\\a b\\c"]);
  });
  test("the surrounding text is untouched and the tokens join back to the text", () => {
    for (const s of ["open `C:\\a b\\c` now", "`/a b/c` and `~/x y/z.md`, then `C:/p q/r`", "`C:\\a b\\c`.", "(`/a b/c`)"]) {
      expect(tokenize(s).map((t) => t.value).join("")).toBe(s);
    }
    expect(values("open `C:\\a b\\c` and `/x y/z.md`, then `~/p q/r`")).toEqual(["C:\\a b\\c", "/x y/z.md", "~/p q/r"]);
  });
  test("a span that is not purely a path stays text where the plain patterns cut it", () => {
    expect(values("`run C:\\a b`")).toEqual(["C:\\a"]);
    expect(values("run C:\\a b")).toEqual(["C:\\a"]);
    expect(values("`cd /a b/c && ls`")).toEqual([]); // not a path, and /a alone is one segment
  });
  test("a segment may hold any words: the delimiters say where the path ends, nothing guesses", () => {
    expect(values("`C:\\a b and more`")).toEqual(["C:\\a b and more"]);
    expect(values("```\nC:\\a b\\c # note\n```")).toEqual(["C:\\a b\\c # note"]);
  });
  test("two paths in one span, flags, redirections and wildcards are not one path", () => {
    expect(values("`/a/b and /c/d`")).toEqual(["/a/b", "/c/d"]);
    expect(values("`/a b/c > /d e/f`")).toEqual([]);
    expect(values("`/a b/*.md`")).toEqual([]);
    expect(values("`C:\\a b\\x?.md`")).toEqual(["C:\\a"]);
    expect(values("`C:\\a b\\c:stream`")).toEqual(["C:\\a"]);
    expect(values("`/a/ b /c`")).toEqual([]);
  });
  test("nested backticks: a longer run holds a shorter one, which is then just text", () => {
    expect(values("`` `C:\\a b\\c` ``")).toEqual(["C:\\a"]); // the content has backticks: not a path
    expect(values("``a `C:\\x y` b``")).toEqual(["C:\\x"]);
    expect(values("`C:\\a b`c`")).toEqual(["C:\\a b"]); // the span closes at the first backtick; the last one is literal
  });
  test("an unmatched backtick is literal and does not swallow the rest", () => {
    expect(values("a ` b ` C:\\a b\\c")).toEqual(["C:\\a"]); // pairs left to right, as Markdown does: ` b ` is the span
    expect(values("a ` b ``C:\\a b\\c``")).toEqual(["C:\\a b\\c"]); // a run of another length is not its closer
    expect(values("`C:\\a b\\c")).toEqual(["C:\\a"]);
  });
  test("a path with no separator after the drive, one POSIX segment, empty segments and network paths are refused", () => {
    for (const bad of ["C:\\", "C:/", "/a b", "~/", "//srv/a b/c", "\\\\srv\\a b\\c", "C:\\\\a b", "/a//b c", "relative/a b", "C:a b\\c", "~a b/c"]) {
      expect(wholePathRange(bad, 0, bad.length), bad).toBeNull();
    }
  });
  test("white space at the start or end of a segment is refused, tabs and newlines too", () => {
    for (const bad of ["/a /b", "/a/ b/c", "C:\\a \\b", "/a/b\tc", "/a/b\nc", "C:\\a b\\ c"]) {
      expect(wholePathRange(bad, 0, bad.length), JSON.stringify(bad)).toBeNull();
    }
    expect(wholePathRange("  /a b/c d  ", 0, 12)).toEqual([2, 10]);
  });
  test("a closing punctuation mark is the sentence's: the plain patterns decide, as before", () => {
    expect(values("`/a/b.`")).toEqual(["/a/b"]);
    expect(values("`/a/b,`")).toEqual(["/a/b"]);
    expect(values('"C:\\a\\b!"')).toEqual(["C:\\a\\b"]);
    expect(values("`/a b/c.`")).toEqual([]); // spaced and punctuated: not guessed
    expect(values("`/a b/shot (1)`")).toEqual(["/a b/shot (1)"]);
  });
  test("at most 4096 characters", () => {
    const ok = "/a b/" + "x".repeat(MAX_TOKEN - 5);
    expect(ok).toHaveLength(MAX_TOKEN);
    expect(wholePathRange(ok, 0, ok.length)).toEqual([0, MAX_TOKEN]);
    const long = ok + "x";
    expect(wholePathRange(long, 0, long.length)).toBeNull();
    expect(paths(`\`${long}\``).map(([v]) => v.length)).toEqual([]); // too long: the plain patterns see /a, which is one segment
  });
});

describe("a quoted string whose whole content is a path", () => {
  test("double quotes, single quotes and typographic quotes", () => {
    for (const [open, close] of [['"', '"'], ["'", "'"], ["\u201c", "\u201d"], ["\u2018", "\u2019"]] as const) {
      expect(paths(`open ${open}${SPACED}${close} now`), open).toEqual([[SPACED, true]]);
      expect(paths(`open ${open}/home/x/città accentata/notes.md${close}.`), open).toEqual([["/home/x/città accentata/notes.md", false]]);
    }
  });
  test("a flag value in quotes", () => {
    expect(values('--out="C:\\a b\\c"')).toEqual(["C:\\a b\\c"]);
    expect(values("--out='/a b/c'")).toEqual(["/a b/c"]);
  });
  test("comma and parentheses inside", () => {
    expect(values('"C:\\a (old), b\\c, d.txt"')).toEqual(["C:\\a (old), b\\c, d.txt"]);
  });
  test("not purely a path: stays text", () => {
    expect(values('"run C:\\a b"')).toEqual(["C:\\a"]);
    expect(values('"C:\\a b" and "/x y/z"')).toEqual(["C:\\a b", "/x y/z"]);
    expect(values("\"hello\" C:\\a b \"world\"")).toEqual(["C:\\a"]);
  });
  test("an apostrophe is not a quote: it does not open one, and does not close one", () => {
    expect(values("it's C:\\a b and don't")).toEqual(["C:\\a"]);
    expect(values("'C:\\Users\\Alex's stuff\\a b'")).toEqual(["C:\\Users\\Alex's stuff\\a b"]);
    expect(values("Alex's folder is C:\\a b\\c")).toEqual(["C:\\a"]);
  });
  test("a quote pair is read once: a code span inside quotes, and quotes inside a code span", () => {
    expect(values('`say "C:\\a b\\c"`')).toEqual(["C:\\a"]); // the span is one unit, and not a path
    // a quote never reaches across a backtick: the code span inside is paired on its own
    expect(values('"see `C:\\a b\\c`"')).toEqual(["C:\\a b\\c"]);
    expect(values("'x `C:\\a b` y'")).toEqual(["C:\\a b"]);
    expect(values('A 27" monitor; the file is in `C:\\My Docs\\out` (see "Display")')).toEqual(["C:\\My Docs\\out"]);
    expect(values("The `README`'s example uses `C:\\My Docs\\out` and 'quotes'")).toEqual(["C:\\My Docs\\out"]);
    expect(values("\u201cx `C:\\a b` y\u201d and \u2018z `/p q/r` w\u2019")).toEqual(["C:\\a b", "/p q/r"]);
  });
  test("a quote whose content has a backtick is never a path, and the quotes after it still pair", () => {
    expect(values('"a `b "C:\\a b"')).toEqual(["C:\\a b"]);
    expect(values("'a `b' 'C:\\a b'")).toEqual(["C:\\a b"]);
    expect(values('`C:\\x y` "C:\\a b"')).toEqual(["C:\\x y", "C:\\a b"]);
  });
  test("a double quote inside a candidate makes it invalid, in a code span and in a fence", () => {
    expect(wholePathRange('C:\\a "b"', 0, 9)).toBeNull();
    expect(values('`C:\\a "b"`')).toEqual(["C:\\a"]);
    expect(values('```\n/a b/"c d"\n```')).toEqual([]);
    expect(values("`/x y/\"z\"`")).toEqual([]);
  });
  test("an apostrophe before a letter is not an opener: `Alex's 'C:\\a b'` is the quoted path", () => {
    expect(values("Alex's 'C:\\a b'")).toEqual(["C:\\a b"]);
    expect(values("Alex\u2019s \u2018C:\\a b\u2019")).toEqual(["C:\\a b"]);
    expect(values("it's 'C:\\a b' and don't")).toEqual(["C:\\a b"]);
  });
  test("unpaired quotes are literal", () => {
    expect(values('a " b " C:\\a b\\c')).toEqual(["C:\\a"]); // quotes pair left to right too
    expect(values('a " b "C:\\a b\\c" "')).toEqual(["C:\\a"]);
    expect(values('"C:\\a b\\c')).toEqual(["C:\\a"]);
  });
  test("what was tokenised joins back to the text", () => {
    for (const s of [`say "${SPACED}" and '${ACCENT}'.`, "\u201c/a b/c\u201d \u2018~/x y\u2019", "\"a\" 'b' `c` \"/a b/c\""]) {
      expect(tokenize(s).map((t) => t.value).join("")).toBe(s);
    }
  });
});

describe("a path on its own line inside a fenced code block", () => {
  test("the whole trimmed line is the path", () => {
    expect(paths("```\nC:\\a b\\c\n```")).toEqual([["C:\\a b\\c", true]]);
    expect(paths("```text\n  /home/x/My Docs/notes.md  \n~/a b\n```")).toEqual([["/home/x/My Docs/notes.md", false], ["~/a b", true]]);
    expect(paths("~~~\n/a b/c d\n~~~")).toEqual([["/a b/c d", true]]);
    expect(paths("````\n/a b/c d\n```\n/e f/g h\n````")).toEqual([["/a b/c d", true], ["/e f/g h", true]]);
  });
  test("outside a fence a path on its own line with spaces is not linked past the first space", () => {
    expect(values("C:\\a b\\c")).toEqual(["C:\\a"]);
    expect(values("text\n\n/home/x/My Docs/notes.md\n\nmore")).toEqual(["/home/x/My"]);
    expect(values("```\nfoo\n```\n/a b/c d")).toEqual([]);
  });
  test("a line with anything else in it is not one path", () => {
    expect(values("```\ncd C:\\a b\\c\n```")).toEqual(["C:\\a"]);
    expect(values("```\n$ ls /a b/c\n```")).toEqual([]);
  });
  test("an unclosed fence runs to the end, and a quote or backtick inside a fence is not read as a delimiter", () => {
    expect(values("```\n/a b/c d")).toEqual(["/a b/c d"]);
    expect(values("```\n`/x y/z`\n\"/p q/r\"\n```")).toEqual([]);
  });
  test("the body helper reads the same lines", () => {
    expect(tokenizeFenceBody("C:\\a b\\c\nhello\n  /x y/z  \n").map((t) => [t.type, t.value])).toEqual([
      ["path", "C:\\a b\\c"],
      ["text", "\nhello\n  "],
      ["path", "/x y/z"],
      ["text", "  \n"],
    ]);
    expect(tokenizeFenceBody("a\nb").map((t) => t.value).join("")).toBe("a\nb");
  });
});

describe("what the label does not do: no guessing from `path:`, `folder:` or `file:`", () => {
  test("a path after a label with spaces is cut at the first space, as before", () => {
    expect(values("path: C:\\a b\\c")).toEqual(["C:\\a"]);
    expect(values("folder: /home/x/My Docs/y")).toEqual(["/home/x/My"]);
    expect(values("file: ~/My Docs/z.md")).toEqual(["~/My"]);
  });
});

describe("tokenizeCode: the content of a code span the markdown parser has cut out", () => {
  test("the whole content is one link, with spaces", () => {
    expect(tokenizeCode(SPACED).map((t) => [t.type, t.value, t.dir === true])).toEqual([["path", SPACED, true]]);
    expect(tokenizeCode(` ${ACCENT} `).map((t) => [t.type, t.value])).toEqual([["text", " "], ["path", ACCENT], ["text", " "]]);
  });
  test("anything else is read by the plain patterns, and quotes inside are text", () => {
    expect(tokenizeCode("run C:\\a b").map((t) => [t.type, t.value])).toEqual([["text", "run "], ["path", "C:\\a"], ["text", " b"]]);
    expect(tokenizeCode('say "C:\\a b\\c"').filter((t) => t.type === "path").map((t) => t.value)).toEqual(["C:\\a"]);
  });
});

describe("the markdown parser keeps these paths literal", () => {
  test("underscores and escapes inside a spaced path are not emphasis or escapes", () => {
    expect(parseInline('"C:\\a b\\__init__ x\\.claude"')).toEqual([{ t: "text", v: '"C:\\a b\\__init__ x\\.claude"' }]);
    expect(parseInline("`C:\\a b\\__init__`")).toEqual([{ t: "code", v: "C:\\a b\\__init__" }]);
  });
  test("quotes inside emphasis: the path is still one token of the text node", () => {
    const [strong] = parseInline('**"C:\\a b\\c"**');
    expect(strong).toMatchObject({ t: "strong" });
    const text = (strong as { c: { t: string; v: string }[] }).c.map((n) => n.v).join("");
    expect(values(text)).toEqual(["C:\\a b\\c"]);
    const [em] = parseInline("*'/x y/z_w'*");
    expect(em).toMatchObject({ t: "em" });
    expect(values((em as { c: { v: string }[] }).c.map((n) => n.v).join(""))).toEqual(["/x y/z_w"]);
  });
});

describe("collectPaths: the allow-list gets exactly the string the window sends", () => {
  const ex = (assistant: string, user = "") => [{
    id: "1",
    user: user ? [{ kind: "text" as const, text: user }] : [],
    assistant: [{ kind: "text" as const, text: assistant }, { kind: "tools" as const, count: 1, items: [] }],
  }];
  test("spaced paths in code spans, quotes and fences are collected whole", () => {
    const found = collectPaths(ex(`see \`${SPACED}\` and "${ACCENT}"\n\n\`\`\`\n/home/x/My Docs/notes.md\n\`\`\``, "'C:\\u v\\w.txt' please")).sort();
    expect(found).toEqual([SPACED, ACCENT, "/home/x/My Docs/notes.md", "C:\\u v\\w.txt"].sort());
  });
  test("a path that is not purely a path is collected as the plain patterns see it", () => {
    expect(collectPaths(ex("`run C:\\a b`"))).toEqual(["C:\\a"]);
  });
  test("the paths the window links are the paths the server collected, for every shape above", () => {
    const text = [`\`${SPACED}\``, `\`\`${ACCENT}\`\``, `"C:\\Q R\\s,t (u).txt"`, "'/home/x/My Docs/é'", "\u201c~/a b/c.md\u201d", "```\n/x y/z w\n```"].join("\n\n");
    const window = tokenize(text).filter((t) => t.type === "path").map((t) => t.value);
    expect(collectPaths(ex(text)).sort()).toEqual(window.map((v) => expandHome(v)).sort());
  });
});

describe("the window: the same links, built from the same tokens", () => {
  // A very small stand-in for the DOM, enough for renderMarkdown to build into.
  class Node {
    children: Node[] = [];
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    className = "";
    title = "";
    tabIndex = -1;
    style: Record<string, string> = {};
    constructor(public tag: string, public text = "") {}
    set textContent(v: string) {
      this.children = [new Node("#text", v)];
    }
    append(...n: Node[]) {
      this.children.push(...n);
    }
    appendChild(n: Node) {
      this.children.push(n);
      return n;
    }
    prepend(...n: Node[]) {
      this.children.unshift(...n);
    }
    replaceChildren(...n: Node[]) {
      this.children = n;
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
  }
  const saved = (globalThis as { document?: unknown }).document;
  beforeAll(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: (t: string) => new Node(t),
      createElementNS: (_ns: string, t: string) => new Node(t),
      createTextNode: (v: string) => new Node("#text", v),
      createDocumentFragment: () => new Node("#fragment"),
    };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = saved;
  });
  const deps = { fileUrl: (p: string) => `/f?p=${encodeURIComponent(p)}`, icon: () => new Node("svg") as never, copy: async () => {} };
  const links = (n: Node): { kind: string; target: string; text: string; dir: boolean }[] => {
    const out: { kind: string; target: string; text: string; dir: boolean }[] = [];
    const walk = (x: Node) => {
      if (x.tag === "a" && x.className.startsWith("link")) {
        out.push({ kind: x.dataset.kind!, target: x.dataset.target!, text: x.children.filter((c) => c.tag === "#text").map((c) => c.text).join(""), dir: x.className.includes("dir") });
      } else for (const c of x.children) walk(c);
    };
    walk(n);
    return out;
  };
  const render = (md: string) => links(renderMarkdown(md, deps) as unknown as Node);

  test("a code span with spaces is one folder link carrying the full path", () => {
    expect(render(`Saved in \`${SPACED}\` today`)).toEqual([{ kind: "dir", target: SPACED, text: SPACED, dir: true }]);
    expect(render(`\`${ACCENT}\``)).toEqual([{ kind: "dir", target: ACCENT, text: ACCENT, dir: true }]);
  });
  test("a file in a code span, a quoted path, and a path in a fenced block are links too", () => {
    expect(render("`/home/x/My Docs/notes.md`")).toEqual([{ kind: "path", target: "/home/x/My Docs/notes.md", text: "/home/x/My Docs/notes.md", dir: false }]);
    expect(render('open "C:\\a b\\c"').map((l) => l.target)).toEqual(["C:\\a b\\c"]);
    expect(render("```\nC:\\a b\\c\nother line\n```").map((l) => [l.kind, l.target])).toEqual([["dir", "C:\\a b\\c"]]);
  });
  test("quotes inside bold or italics, and a code span that is not purely a path", () => {
    expect(render('**"C:\\a b\\c"**').map((l) => l.target)).toEqual(["C:\\a b\\c"]);
    expect(render("*'/x y/z'*").map((l) => l.target)).toEqual(["/x y/z"]);
    expect(render("`run C:\\a b`").map((l) => l.target)).toEqual(["C:\\a"]);
  });
  test("every link the window builds is a path the server's tokenizer produced for the same markdown", () => {
    const md = [`\`${SPACED}\``, `"${ACCENT}"`, "'/home/x/My Docs/é.md'", "```\n/x y/z w\n```", "**\u201c~/a b/c\u201d**"].join("\n\n");
    const shown = render(md).map((l) => l.target).sort();
    const server = tokenize(md).filter((t) => t.type === "path").map((t) => t.value).sort();
    expect(shown).toEqual(server);
  });
  describe("the window and the server agree on every shape (same markdown, same paths)", () => {
    const side = (md: string) => {
      const shown = [...new Set(render(md).filter((l) => l.kind !== "url").map((l) => expandHome(l.target)))].sort();
      const server = collectPaths([{ id: "1", user: [], assistant: [{ kind: "text", text: md }] }]).sort();
      return { shown, server };
    };
    const agree = (md: string): string[] => {
      const { shown, server } = side(md);
      expect(shown, JSON.stringify(md)).toEqual(server);
      return server;
    };
    test("quotes around a code span (the four lines of the review)", () => {
      expect(agree("\"`Sidecr`'s folder is `C:\\My Docs\\out`, it's 'fine'\"")).toEqual(["C:\\My Docs\\out"]);
      expect(agree("The `README`'s example uses `C:\\My Docs\\out` and 'quotes'")).toEqual(["C:\\My Docs\\out"]);
      expect(agree('A 27" monitor; the file is in `C:\\My Docs\\out` (see "Display")')).toEqual(["C:\\My Docs\\out"]);
      expect(agree("'x `C:\\a b` y'")).toEqual(["C:\\a b"]);
    });
    test("more shapes with quotes, apostrophes and code spans", () => {
      for (const md of [
        "`A` and 'B' and `C:\\a b\\c`",
        "\"a `b` c\" `/x y/z`",
        "\u201cquoted `C:\\a b` text\u201d",
        "\u2018single `/p q/r` text\u2019",
        "Alex's \"C:\\a b\" and `/x y/z` and 'it's'",
        "5\" screen, 6\" phone, `~/My Docs/x`",
        "**'C:\\a b'** and *\"/x y/z\"* and ~~`~/p q`~~",
        "`a` `b` `c` \"C:\\a b\" `d`",
        "``C:\\a b`` `C:\\x y` \"/m n/o\"",
      ]) {
        agree(md);
      }
    });
    test("fences: in a quote, in a list item, indented by tabs or spaces, with longer closers, unclosed", () => {
      const p = "/home/x/My Docs/notes.md";
      for (const md of [
        `> \`\`\`\n> ${p}\n> \`\`\``,
        `- item\n\n  \`\`\`\n  ${p}\n  \`\`\``,
        `- \`\`\`\n  ${p}\n  \`\`\``,
        `1. step\n   \`\`\`sh\n   C:\\a b\\c\n   \`\`\``,
        `\t\`\`\`\n${p}\n\`\`\``,
        `    \`\`\`\n${p}\n    \`\`\`\n\n\`${p}\``,
        `\`\`\`\n${p}\n    \`\`\`\n/x y/z w\n\`\`\``,
        `\`\`\`\n${p}\n\`\`\`\`\n/x y/z w`,
        `~~~\n${p}\n~~~\n\n\`C:\\a b\``,
        `\`\`\`\n${p}`,
        `text\n\`\`\`md\n\`\`\`\n${p}\n\`\`\`\n\`\`\`\n/e f/g h\n\`\`\``,
      ]) {
        agree(md);
      }
    });
    test("a code span split over two lines, links, headings, tables and lists", () => {
      for (const md of [
        "`C:\\a\nb`",
        "see `C:\\a b\\c` and\n`/x y/z`",
        "# `C:\\a b` and \"/x y/z\"",
        "[`C:\\a b\\c`](https://example.com) and `/x y/z`",
        "[C:\\a b](C:\\x y) and [t](javascript:alert(1)) `~/p q`",
        "| a | b |\n|---|---|\n| `C:\\a b` | \"/x y/z\" |",
        "- `C:\\a b`\n- \"/x y/z\"\n  - '~/p q/r'",
        "> quote `C:\\a b`\n> \"/x y/z\"",
      ]) {
        agree(md);
      }
    });
    test("a user's text is plain text: both sides read it with the tokenizer, fences included", () => {
      for (const md of ["\t```\n/x y/z\n```", "> ```\n> /x y/z\n> ```", "- ```\n  /x y/z\n  ```", "`C:\\a b` \"/x y/z\" 'p q'", "```\n/x y/z"]) {
        const serverUser = collectPaths([{ id: "1", user: [{ kind: "text", text: md }], assistant: [] }]).sort();
        const shown = [...new Set(links(renderText(md, deps.fileUrl) as unknown as Node).map((l) => expandHome(l.target)))].sort();
        expect(shown, JSON.stringify(md)).toEqual(serverUser);
      }
    });
  });
  test("a link is data only: no href, the text is a text node", () => {
    const frag = renderMarkdown("`/a b/c`", deps) as unknown as Node;
    const a = (function find(x: Node): Node | null {
      if (x.tag === "a") return x;
      for (const c of x.children) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    })(frag)!;
    expect(a.attrs.href).toBeUndefined();
    expect(a.children.some((c) => c.tag === "#text" && c.text === "/a b/c")).toBe(true);
  });
});

describe("the server allows exactly that string and opens it", () => {
  const root = mkdtempSync(join(tmpdir(), "sidecr-spaced-"));
  const projects = join(root, "projects");
  const uiDir = join(root, "ui");
  const distDir = join(root, "dist");
  mkdirSync(uiDir);
  mkdirSync(distDir);
  writeFileSync(join(uiDir, "index.html"), "<html></html>");
  const folder = join(root, "with spaces");
  const accent = join(root, "città accentata");
  mkdirSync(folder);
  mkdirSync(accent);
  const file = join(folder, "my notes, v2 (final).md");
  writeFileSync(file, "x");
  const page = join(folder, "my page.html");
  writeFileSync(page, "<p>x</p>");
  const other = join(root, "other folder");
  mkdirSync(other);
  const CWD = join(root, "work");
  mkdirSync(projects, { recursive: true });
  const sessionDir = join(projects, encodeCwd(CWD));
  mkdirSync(sessionDir, { recursive: true });
  const text = `the folder \`${folder}\`, then "${accent}" and \`${file}\` and '${page}'.\n\nNot this one: ${other} or run ${other}`;
  writeFileSync(
    join(sessionDir, "sess-1.jsonl"),
    [
      { type: "user", uuid: "u1", message: { role: "user", content: "go" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const pane = (id: string): PaneInfo => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: "sess-1", cwd: CWD, title: "t", workspaceId: "w1" });
  const herdr: HerdrLike = {
    getPane: async (id) => pane(id),
    listAgentPanes: async () => [pane("w1:p1")],
    listWorkspaces: async () => [{ id: "w1", label: "personal" }],
    readScreen: async () => "",
    sendText: async () => {},
    sendKeys: async () => {},
  };
  const calls: { target: string; kind?: "dir" | "reveal" }[] = [];
  const { server } = createServer({
    herdr, token: "tok-spaced", attachmentsDir: join(root, "attachments"), projectsRoot: projects, uiDir, distDir,
    opener: async (target, kind) => void calls.push({ target, kind }),
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${Number(server.port)}`;
  const post = (body: unknown) =>
    fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie: "sidecr=tok-spaced" } });

  test("the folders, the file and the page open with the string the window would send", async () => {
    calls.length = 0;
    expect((await post({ pane: "w1:p1", kind: "dir", target: folder })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "dir", target: accent })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "path", target: file })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "path", target: page })).status).toBe(200);
    expect(calls.map((c) => c.target)).toEqual([realpathSync(folder), realpathSync(accent), file, page]);
  });
  test("a prefix cut at the first space is not what the conversation mentioned (the folder is only allowed as written)", async () => {
    calls.length = 0;
    expect((await post({ pane: "w1:p1", kind: "path", target: join(root, "with") })).status).toBe(403);
    expect((await post({ pane: "w1:p1", kind: "dir", target: join(root, "nothing here") })).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test("a folder named only in plain prose with spaces is not linked past the first space, so it is not handed out", async () => {
    calls.length = 0;
    const res = await post({ pane: "w1:p1", kind: "dir", target: other });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("linear time on adversarial input (200,000 characters, 250 ms)", () => {
  const SIZE = 200_000;
  const hostile = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const units: [string, string][] = [
    ["backticks", "`"],
    ["backtick pairs", "``"],
    ["growing backtick runs", "` `` ``` ```` ````` "],
    ["code spans of a path", "`/a b/c` "],
    ["code spans of Windows paths", "`C:\\a b\\c` "],
    ["code spans, mismatched runs", "`/a b/c`` "],
    ["alternating run lengths", "`a``b```c````d"],
    ["spaces between backticks", "` ` "],
    ["double quotes", '"'],
    ["double quote pairs", '""'],
    ["quoted paths", '"/a b/c" '],
    ["quoted paths, one quote missing", '"/a b/c '],
    ["single quotes", "'"],
    ["single quote pairs around words", "'a'a"],
    ["single quotes around spaces", "' ' "],
    ["single quoted paths", "'/a b/c' "],
    ["apostrophes", "it's "],
    ["typographic double quotes", "\u201c"],
    ["typographic closers", "\u201d"],
    ["typographic quoted paths", "\u201c/a b/c\u201d "],
    ["typographic single quotes", "\u2018"],
    ["typographic single quoted paths", "\u2018/a b/c\u2019 "],
    ["every opener", "`\"'\u201c\u2018"],
    ["openers then a path", "`\"'\u201c\u2018/a b/c "],
    ["fence lines", "```\n"],
    ["fenced paths", "```\n/a b/c\n"],
    ["fenced paths closed", "```\n/a b/c\n```\n"],
    ["tilde fences", "~~~\n/a b\n"],
    ["tildes", "~"],
    ["lines of one quote", '"\n'],
    ["lines of one backtick", "`\n"],
    ["lines of a quoted path", '"/a b/c"\n'],
    ["spaces", " "],
    ["path-like noise", "C:\\a b/c d:e/f g\\"],
    ["slashes and spaces", "/ a / b / "],
    ["quote then spaces", '" '],
  ];
  test.each(units)("%s", (_name, unit) => {
    const s = hostile(unit);
    expect(s).toHaveLength(SIZE);
    for (const [label, run] of [
      ["tokenize", () => tokenize(s)],
      ["tokenizeCode", () => tokenizeCode(s)],
      ["tokenizeFenceBody", () => tokenizeFenceBody(s)],
      ["collectPaths", () => collectPaths([{ id: "1", user: [], assistant: [{ kind: "text", text: s }] }])],
      ["parseInline", () => parseInline(s)],
      ["parseMarkdown", () => parseMarkdown(s)],
    ] as const) {
      const start = performance.now();
      run();
      expect(performance.now() - start, `${label} on ${JSON.stringify(unit)}`).toBeLessThan(budget(250));
    }
    expect(tokenize(s).map((t) => t.value).join("")).toBe(s);
  });
  test("one huge delimited string that is not a path, and one that is too long", () => {
    for (const s of ["`" + "/a b".repeat(50_000) + "`", '"' + "/a b/".repeat(40_000) + '"', "`/a b/" + "x".repeat(SIZE) + "`", `"C:\\${"a b\\".repeat(40_000)}"`]) {
      const t = performance.now();
      const tokens = tokenize(s);
      expect(performance.now() - t).toBeLessThan(budget(250));
      expect(tokens.map((x) => x.value).join("")).toBe(s);
    }
  });
});
