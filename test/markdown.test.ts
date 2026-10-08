import { describe, expect, test } from "bun:test";
import { tokenize } from "../src/tokenize";
import { blockPlainText, maxInlineDepth, parseInline, parseMarkdown, safeHref, type Block, type Inline } from "../ui/markdown";
import { budget } from "./timing";

const T = (v: string): Inline => ({ t: "text", v });
const code = (v: string): Inline => ({ t: "code", v });
const strong = (...c: Inline[]): Inline => ({ t: "strong", c });
const em = (...c: Inline[]): Inline => ({ t: "em", c });
const del = (...c: Inline[]): Inline => ({ t: "del", c });
const link = (href: string, ...c: Inline[]): Inline => ({ t: "link", href, c });
const br: Inline = { t: "br" };
const p = (...c: Inline[]): Block => ({ t: "p", c });

describe("parseInline: constructs", () => {
  test("plain text is one text node", () => {
    expect(parseInline("hello world")).toEqual([T("hello world")]);
    expect(parseInline("")).toEqual([]);
  });
  test("inline code with one and two backticks", () => {
    expect(parseInline("a `b` c")).toEqual([T("a "), code("b"), T(" c")]);
    expect(parseInline("``a`b``")).toEqual([code("a`b")]);
  });
  test("nothing is parsed inside inline code", () => {
    expect(parseInline("`**x** [a](https://b.c) _y_`")).toEqual([code("**x** [a](https://b.c) _y_")]);
  });
  test("bold with ** and __", () => {
    expect(parseInline("a **b** c")).toEqual([T("a "), strong(T("b")), T(" c")]);
    expect(parseInline("a __b__ c")).toEqual([T("a "), strong(T("b")), T(" c")]);
  });
  test("italic with * and _", () => {
    expect(parseInline("a *b* c")).toEqual([T("a "), em(T("b")), T(" c")]);
    expect(parseInline("a _b_ c")).toEqual([T("a "), em(T("b")), T(" c")]);
  });
  test("strikethrough with ~~", () => {
    expect(parseInline("a ~~b~~ c")).toEqual([T("a "), del(T("b")), T(" c")]);
  });
  test("emphasis nests", () => {
    expect(parseInline("**a *b* c**")).toEqual([strong(T("a "), em(T("b")), T(" c"))]);
    expect(parseInline("***a***")).toEqual([em(strong(T("a")))]);
    expect(parseInline("**`x` and ~~y~~**")).toEqual([strong(code("x"), T(" and "), del(T("y")))]);
  });
  test("emphasis next to punctuation", () => {
    expect(parseInline("(**a**)")).toEqual([T("("), strong(T("a")), T(")")]);
    expect(parseInline("**a:** b")).toEqual([strong(T("a:")), T(" b")]);
  });
  test("a link with an https URL", () => {
    expect(parseInline("[hi](https://a.b/c)")).toEqual([link("https://a.b/c", T("hi"))]);
    expect(parseInline("see [the **docs**](https://x.y/z?q=1) now")).toEqual([
      T("see "),
      link("https://x.y/z?q=1", T("the "), strong(T("docs"))),
      T(" now"),
    ]);
  });
  test("a link may carry a title, which is dropped", () => {
    expect(parseInline('[a](https://x.y "the title")')).toEqual([link("https://x.y", T("a"))]);
  });
  test("a link URL may hold balanced parentheses", () => {
    expect(parseInline("[w](https://en.wikipedia.org/wiki/A_(b))")).toEqual([link("https://en.wikipedia.org/wiki/A_(b)", T("w"))]);
  });
  test("javascript: links still parse as link nodes (safeHref rejects them later)", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([link("javascript:alert(1)", T("x"))]);
  });
  test("bare URLs stay text", () => {
    expect(parseInline("see https://a.b/c_d_e and https://x.y now")).toEqual([T("see https://a.b/c_d_e and https://x.y now")]);
  });
  test("a newline becomes br", () => {
    expect(parseInline("a\nb")).toEqual([T("a"), br, T("b")]);
    expect(parseInline("a  \n  b")).toEqual([T("a"), br, T("b")]);
  });
  test("Windows line endings are normalised", () => {
    expect(parseInline("a\r\nb")).toEqual([T("a"), br, T("b")]);
  });
});

describe("parseInline: false positives stay literal", () => {
  test("underscores inside words are not emphasis", () => {
    expect(parseInline("snake_case_name")).toEqual([T("snake_case_name")]);
    expect(parseInline("snake_case and _em_")).toEqual([T("snake_case and "), em(T("em"))]);
    expect(parseInline("__init__.py and my__var__x")).toEqual([T("__init__.py and my__var__x")]);
  });
  test("2*3*4 is not emphasis", () => {
    expect(parseInline("2*3*4")).toEqual([T("2*3*4")]);
    expect(parseInline("a*b*c and 2 * 3 * 4")).toEqual([T("a*b*c and 2 * 3 * 4")]);
  });
  test("a lone * or _ stays literal", () => {
    expect(parseInline("*")).toEqual([T("*")]);
    expect(parseInline("_")).toEqual([T("_")]);
    expect(parseInline("a * b")).toEqual([T("a * b")]);
    expect(parseInline("a _ b")).toEqual([T("a _ b")]);
    expect(parseInline("*a")).toEqual([T("*a")]);
    expect(parseInline("a_")).toEqual([T("a_")]);
  });
  test("spaces inside the delimiters cancel emphasis", () => {
    expect(parseInline("a ** b ** c")).toEqual([T("a ** b ** c")]);
    expect(parseInline("** a**")).toEqual([T("** a**")]);
  });
  test("an unclosed ** stays literal", () => {
    expect(parseInline("**a")).toEqual([T("**a")]);
    expect(parseInline("a **b *c*")).toEqual([T("a **b "), em(T("c"))]);
  });
  test("an unclosed backtick stays literal", () => {
    expect(parseInline("`a")).toEqual([T("`a")]);
    expect(parseInline("a ``b` c")).toEqual([T("a ``b` c")]);
  });
  test("an unclosed [ stays literal", () => {
    expect(parseInline("[a")).toEqual([T("[a")]);
    expect(parseInline("[a](")).toEqual([T("[a](")]);
    expect(parseInline("[a](https://b.c")).toEqual([T("[a](https://b.c")]);
    expect(parseInline("[a]")).toEqual([T("[a]")]);
    expect(parseInline("[a] (https://b.c)")).toEqual([T("[a] (https://b.c)")]);
  });
  test("a single ~ is literal", () => {
    expect(parseInline("~single~ and ~/path ~~~")).toEqual([T("~single~ and ~/path ~~~")]);
  });
  test("a backslash escapes the next punctuation character", () => {
    expect(parseInline("\\*a\\*")).toEqual([T("*a*")]);
    expect(parseInline("\\`x\\` \\[a](https://b.c) \\_b\\_")).toEqual([T("`x` [a](https://b.c) _b_")]);
    expect(parseInline("a \\| b")).toEqual([T("a | b")]);
  });
  test("a backslash before a letter stays", () => {
    expect(parseInline("a\\b and \\n")).toEqual([T("a\\b and \\n")]);
  });
  test("a trailing backslash stays", () => {
    expect(parseInline("a\\")).toEqual([T("a\\")]);
  });
  test("Windows paths keep their backslashes", () => {
    expect(parseInline("see C:\\Users\\alice\\.claude\\skills\\x.md now")).toEqual([T("see C:\\Users\\alice\\.claude\\skills\\x.md now")]);
    expect(parseInline("**C:\\a\\.b**")).toEqual([strong(T("C:\\a\\.b"))]);
  });
  test("raw HTML stays literal text", () => {
    expect(parseInline("<script>alert(1)</script> <b>x</b> <img src=x onerror=y>")).toEqual([
      T("<script>alert(1)</script> <b>x</b> <img src=x onerror=y>"),
    ]);
  });
  test("an image marker is not special: the bang stays, the rest is a link", () => {
    expect(parseInline("![alt](https://a.b/i.png)")).toEqual([T("!"), link("https://a.b/i.png", T("alt"))]);
  });
});

describe("parseMarkdown: blocks", () => {
  test("empty input gives no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
  test("paragraphs are separated by blank lines and single newlines become br", () => {
    expect(parseMarkdown("a\nb\n\nc")).toEqual([p(T("a"), br, T("b")), p(T("c"))]);
  });
  test("ATX headings, levels 1 to 6", () => {
    const out = parseMarkdown("# a\n## b\n### c\n#### d\n##### e\n###### f");
    expect(out.map((b) => (b.t === "h" ? b.level : 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out[0]).toEqual({ t: "h", level: 1, c: [T("a")] });
  });
  test("a heading needs a space, has at most 6 hashes, and can carry closing hashes and inline markup", () => {
    expect(parseMarkdown("#hashtag")).toEqual([p(T("#hashtag"))]);
    expect(parseMarkdown("####### seven")).toEqual([p(T("####### seven"))]);
    expect(parseMarkdown("## Title ##")).toEqual([{ t: "h", level: 2, c: [T("Title")] }]);
    expect(parseMarkdown("# a **b**")).toEqual([{ t: "h", level: 1, c: [T("a "), strong(T("b"))] }]);
  });
  test("a fenced code block with a language", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n\nlet b;\n```")).toEqual([
      { t: "code", lang: "ts", v: "const a = 1;\n\nlet b;", closed: true },
    ]);
  });
  test("a fence without a language, and a ~~~ fence", () => {
    expect(parseMarkdown("```\nx\n```")).toEqual([{ t: "code", lang: "", v: "x", closed: true }]);
    expect(parseMarkdown("~~~python\nprint(1)\n~~~")).toEqual([{ t: "code", lang: "python", v: "print(1)", closed: true }]);
  });
  test("only the first word of the info string is the language", () => {
    expect(parseMarkdown("```js title=a.js\nx\n```")).toEqual([{ t: "code", lang: "js", v: "x", closed: true }]);
  });
  test("markdown inside a fence is not parsed", () => {
    expect(parseMarkdown("```\n# not a heading\n- not a list\n**x**\n```")).toEqual([
      { t: "code", lang: "", v: "# not a heading\n- not a list\n**x**", closed: true },
    ]);
  });
  test("an unclosed fence is returned with closed false and swallows the rest", () => {
    expect(parseMarkdown("before\n\n```js\nconst a = 1;\n\n# still code")).toEqual([
      p(T("before")),
      { t: "code", lang: "js", v: "const a = 1;\n\n# still code", closed: false },
    ]);
  });
  test("a fence is closed only by a fence at least as long", () => {
    expect(parseMarkdown("````md\n```\ninner\n```\n````")).toEqual([{ t: "code", lang: "md", v: "```\ninner\n```", closed: true }]);
    expect(parseMarkdown("```\na\n~~~\nb")).toEqual([{ t: "code", lang: "", v: "a\n~~~\nb", closed: false }]);
  });
  test("an empty fence", () => {
    expect(parseMarkdown("```\n```")).toEqual([{ t: "code", lang: "", v: "", closed: true }]);
  });
  test("blockquotes, with blocks inside", () => {
    expect(parseMarkdown("> a\n> b")).toEqual([{ t: "quote", c: [p(T("a"), br, T("b"))] }]);
    expect(parseMarkdown("> # h\n>\n> - x")).toEqual([
      { t: "quote", c: [{ t: "h", level: 1, c: [T("h")] }, { t: "ul", items: [[p(T("x"))]] }] },
    ]);
    expect(parseMarkdown(">a")).toEqual([{ t: "quote", c: [p(T("a"))] }]);
  });
  test("nested blockquotes", () => {
    expect(parseMarkdown("> a\n>> b")).toEqual([{ t: "quote", c: [p(T("a")), { t: "quote", c: [p(T("b"))] }] }]);
  });
  test("unordered lists with -, * and +", () => {
    for (const m of ["-", "*", "+"]) {
      expect(parseMarkdown(`${m} a\n${m} b`), m).toEqual([{ t: "ul", items: [[p(T("a"))], [p(T("b"))]] }]);
    }
  });
  test("ordered lists with 1. and 1), and a start number", () => {
    expect(parseMarkdown("1. a\n2. b")).toEqual([{ t: "ol", items: [[p(T("a"))], [p(T("b"))]] }]);
    expect(parseMarkdown("1) a\n2) b")).toEqual([{ t: "ol", items: [[p(T("a"))], [p(T("b"))]] }]);
    expect(parseMarkdown("3. a\n4. b")).toEqual([{ t: "ol", start: 3, items: [[p(T("a"))], [p(T("b"))]] }]);
  });
  test("a list item holds inline markup", () => {
    expect(parseMarkdown("- **Key:** value")).toEqual([{ t: "ul", items: [[p(strong(T("Key:")), T(" value"))]] }]);
  });
  test("nested lists, two levels, by two-space indentation", () => {
    expect(parseMarkdown("- a\n  - b\n  - c\n- d")).toEqual([
      {
        t: "ul",
        items: [
          [p(T("a")), { t: "ul", items: [[p(T("b"))], [p(T("c"))]] }],
          [p(T("d"))],
        ],
      },
    ]);
  });
  test("nested lists under an ordered item (two or three spaces, mixed kinds)", () => {
    const expected = [
      { t: "ol", items: [[p(T("a")), { t: "ul", items: [[p(T("b"))]] }], [p(T("c"))]] },
    ];
    expect(parseMarkdown("1. a\n   - b\n2. c")).toEqual(expected as Block[]);
    expect(parseMarkdown("1. a\n  - b\n2. c")).toEqual(expected as Block[]);
  });
  test("three levels of nesting", () => {
    expect(parseMarkdown("- a\n  - b\n    - c")).toEqual([
      { t: "ul", items: [[p(T("a")), { t: "ul", items: [[p(T("b")), { t: "ul", items: [[p(T("c"))]] }]] }]] },
    ]);
  });
  test("a list item can hold a fenced code block, even with a blank line or an unindented line inside", () => {
    expect(parseMarkdown("1. Run:\n   ```sh\n   a\n\nb\n   ```\n2. Done")).toEqual([
      {
        t: "ol",
        items: [
          [p(T("Run:")), { t: "code", lang: "sh", v: "a\n\nb", closed: true }],
          [p(T("Done"))],
        ],
      },
    ]);
  });
  test("an item continues over a blank line when the next line is indented", () => {
    expect(parseMarkdown("- a\n\n  more\n- b")).toEqual([{ t: "ul", items: [[p(T("a")), p(T("more"))], [p(T("b"))]] }]);
  });
  test("a blank line then an unindented paragraph ends the list", () => {
    expect(parseMarkdown("- a\n\nafter")).toEqual([{ t: "ul", items: [[p(T("a"))]] }, p(T("after"))]);
  });
  test("a lazy continuation line joins the item", () => {
    expect(parseMarkdown("- a\nb")).toEqual([{ t: "ul", items: [[p(T("a"), br, T("b"))]] }]);
  });
  test("a bullet list interrupts a paragraph, a bare number does not", () => {
    expect(parseMarkdown("intro\n- a\n- b")).toEqual([p(T("intro")), { t: "ul", items: [[p(T("a"))], [p(T("b"))]] }]);
    expect(parseMarkdown("in 2024.\n2025. later")).toEqual([p(T("in 2024."), br, T("2025. later"))]);
  });
  test("switching between bullet and number starts a new list", () => {
    expect(parseMarkdown("- a\n1. b")).toEqual([{ t: "ul", items: [[p(T("a"))]] }, { t: "ol", items: [[p(T("b"))]] }]);
  });
  test("bold at the start of a line is not a list", () => {
    expect(parseMarkdown("**a** b")).toEqual([p(strong(T("a")), T(" b"))]);
    expect(parseMarkdown("*a* b")).toEqual([p(em(T("a")), T(" b"))]);
  });
  test("horizontal rules", () => {
    for (const r of ["---", "***", "___", "* * *", "- - -", "-----"]) expect(parseMarkdown(r), r).toEqual([{ t: "hr" }]);
    expect(parseMarkdown("a\n\n---\n\nb")).toEqual([p(T("a")), { t: "hr" }, p(T("b"))]);
  });
  test("a GFM table with alignment", () => {
    expect(parseMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | **2** | 3 |\n| x | y | z |")).toEqual([
      {
        t: "table",
        head: [[T("a")], [T("b")], [T("c")]],
        align: ["left", "center", "right"],
        rows: [
          [[T("1")], [strong(T("2"))], [T("3")]],
          [[T("x")], [T("y")], [T("z")]],
        ],
      },
    ]);
  });
  test("a table without outer pipes, and no alignment", () => {
    expect(parseMarkdown("a | b\n--- | ---\n1 | 2")).toEqual([
      { t: "table", head: [[T("a")], [T("b")]], align: [null, null], rows: [[[T("1")], [T("2")]]] },
    ]);
  });
  test("short rows are padded and long rows trimmed to the header width", () => {
    const [t] = parseMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
    expect(t).toEqual({
      t: "table",
      head: [[T("a")], [T("b")]],
      align: [null, null],
      rows: [[[T("1")], []], [[T("1")], [T("2")]]],
    });
  });
  test("an escaped pipe stays inside its cell", () => {
    const [t] = parseMarkdown("| a | b |\n|---|---|\n| x \\| y | z |");
    expect((t as Extract<Block, { t: "table" }>).rows).toEqual([[[T("x | y")], [T("z")]]]);
  });
  test("a table ends at a blank line", () => {
    const out = parseMarkdown("| a |\n|---|\n| 1 |\n\nafter");
    expect(out.map((b) => b.t)).toEqual(["table", "p"]);
  });
  test("a pipe line without a separator row is a paragraph", () => {
    expect(parseMarkdown("a | b\nnot a separator")).toEqual([p(T("a | b"), br, T("not a separator"))]);
  });
  test("a separator with a different number of cells is not a table", () => {
    expect(parseMarkdown("| a | b |\n|---|")[0].t).toBe("p");
  });
  test("a table interrupts a paragraph", () => {
    const out = parseMarkdown("intro\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out.map((b) => b.t)).toEqual(["p", "table"]);
  });
  test("Windows line endings are normalised", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toEqual([p(T("a")), p(T("b"))]);
    expect(parseMarkdown("```js\r\nx\r\n```\r\n")).toEqual([{ t: "code", lang: "js", v: "x", closed: true }]);
  });
  test("a javascript: link parses to a link node; the block layer does not sanitise", () => {
    expect(parseMarkdown("[x](javascript:alert(1))")).toEqual([p(link("javascript:alert(1)", T("x")))]);
  });
  test("raw HTML stays literal text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([p(T("<script>alert(1)</script>"))]);
  });
  test("a realistic answer", () => {
    const src = [
      "## Result",
      "",
      "I changed `src/a.ts`:",
      "",
      "```ts",
      "export const a = 1;",
      "```",
      "",
      "1. First",
      "2. Second",
      "",
      "> note",
    ].join("\n");
    expect(parseMarkdown(src).map((b) => b.t)).toEqual(["h", "p", "code", "ol", "quote"]);
  });
});

describe("parseMarkdown: never throws, never hangs", () => {
  const started = () => performance.now();
  const fast = (t0: number, ms = 1500) => expect(performance.now() - t0).toBeLessThan(budget(ms));

  test("5000 asterisks", () => {
    const t0 = started();
    parseMarkdown("*".repeat(5000));
    parseInline("*".repeat(5000));
    fast(t0);
  });
  test("5000 open brackets, with and without a closing one", () => {
    const t0 = started();
    parseMarkdown("[".repeat(5000));
    parseMarkdown("[".repeat(5000) + "](x)");
    parseInline("[]( ".repeat(2000));
    fast(t0);
  });
  test("other pathological inline strings", () => {
    const t0 = started();
    for (const s of ["*a ".repeat(5000), "a* ".repeat(5000), "_a_ ".repeat(3000), "`".repeat(5000), "`a``".repeat(2000), "~~a ".repeat(3000), "\\".repeat(5000), "*_".repeat(3000), "**a_".repeat(2000)]) {
      parseInline(s);
    }
    fast(t0);
  });
  test("deeply nested blockquotes and lists", () => {
    const t0 = started();
    parseMarkdown("> ".repeat(5000) + "x");
    parseMarkdown(Array.from({ length: 3000 }, () => ">").join("\n"));
    parseMarkdown(Array.from({ length: 3000 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"));
    parseMarkdown("- ".repeat(5000) + "x");
    fast(t0);
  });
  test("a long table and a long list", () => {
    const t0 = started();
    parseMarkdown("| a | b |\n|---|---|\n" + "| 1 | 2 |\n".repeat(5000));
    parseMarkdown("- x\n".repeat(5000));
    fast(t0);
  });
  test("odd input does not throw", () => {
    for (const s of ["", "\0", "\u2028", "```", "~~~", "|", "|\n|", "| a |\n|", "# ", "- ", "1.", ">", "\\", "[", "](", "\ud800", "a\n\n\n\nb", "\t- a\n\t\t- b"]) {
      expect(() => parseMarkdown(s), JSON.stringify(s)).not.toThrow();
    }
  });
});

describe("safeHref", () => {
  test("accepts http and https URLs", () => {
    expect(safeHref("https://a.b/c?d=e")).toBe("https://a.b/c?d=e");
    expect(safeHref("http://localhost:3000/x#y")).toBe("http://localhost:3000/x#y");
  });
  test("returns the normalised URL: scheme and host lower-cased, a bare host gains the trailing slash", () => {
    expect(safeHref("HTTPS://A.B/C")).toBe("https://a.b/C");
    expect(safeHref("HtTp://a.b")).toBe("http://a.b/");
    expect(safeHref("https://a.b")).toBe("https://a.b/");
    expect(safeHref("https://a.b:443/x")).toBe("https://a.b/x");
  });
  test("a homograph host shows as punycode", () => {
    expect(safeHref(`https://${String.fromCharCode(0x430)}pple.com/x`)).toBe("https://xn--pple-43d.com/x");
  });
  test("a backslash cannot hide a host: it is normalised to a slash", () => {
    expect(safeHref("https://good.com\\@evil.com")).toBe("https://good.com/@evil.com");
  });
  test("the title, the target and the opener all get the same string", () => {
    const href = safeHref("  HTTPS://Example.COM  ");
    expect(href).toBe("https://example.com/");
    expect(safeHref(href!)).toBe(href); // idempotent
  });
  test("trims surrounding whitespace", () => {
    expect(safeHref("  https://a.b/c  ")).toBe("https://a.b/c");
  });
  test("rejects other schemes", () => {
    for (const h of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "ftp://a.b", "mailto:a@b.c", "blob:https://a.b/x"]) {
      expect(safeHref(h), h).toBeNull();
    }
  });
  test("rejects scheme-relative, relative and empty values", () => {
    for (const h of ["//evil", "//evil.com/x", "/relative", "relative/path", "a.b/c", "", "   ", "https:", "https://", "http:/a.b", "https:a.b"]) {
      expect(safeHref(h), h).toBeNull();
    }
  });
  test("rejects whitespace and control characters inside", () => {
    for (const h of ["https://a.b/c d", "https://a.b/\nfoo", "https://a.b/\tfoo", "https://a.b/\rx", "https://a.b/\u0000", "https://a.b/\u0007x", "https://a.b/\u007fx", "https://a.b/\u0085x", "https://a\u2028.b"]) {
      expect(safeHref(h), JSON.stringify(h)).toBeNull();
    }
  });
  test("scheme tricks with whitespace or control characters do not pass", () => {
    for (const h of ["java\nscript:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "\u0001javascript:alert(1)", "https://a.b\njavascript:alert(1)", "\u0000https://a.b"]) {
      expect(safeHref(h), JSON.stringify(h)).toBeNull();
    }
  });
  test("rejects URLs longer than 2000 characters", () => {
    const base = "https://a.b/";
    expect(safeHref(base + "x".repeat(2000 - base.length))).not.toBeNull();
    expect(safeHref(base + "x".repeat(2001 - base.length))).toBeNull();
  });
  test("never throws", () => {
    for (const h of ["https://[", "http://%", "https://a b", "\ud800"]) expect(() => safeHref(h), h).not.toThrow();
  });
});

describe("fix round 1: bounded nesting", () => {
  const t0 = () => performance.now();
  test("deeply nested emphasis stops at 32 levels", () => {
    for (const n of [100, 10000]) {
      const start = t0();
      const out = parseInline("*a ".repeat(n) + "a* ".repeat(n));
      expect(maxInlineDepth(out), String(n)).toBeLessThanOrEqual(32);
      expect(performance.now() - start).toBeLessThan(budget(1500));
    }
  });
  test("a long run of asterisks around a word does not nest past 32 either", () => {
    const out = parseInline("*".repeat(5000) + "a" + "*".repeat(5000));
    expect(maxInlineDepth(out)).toBeLessThanOrEqual(32);
  });
  test("nesting below the cap still works", () => {
    const out = parseInline("*a ".repeat(10) + "a* ".repeat(10));
    expect(maxInlineDepth(out)).toBe(10);
  });
  test("maxInlineDepth counts emphasis and links", () => {
    expect(maxInlineDepth(parseInline("plain"))).toBe(0);
    expect(maxInlineDepth(parseInline("**a**"))).toBe(1);
    expect(maxInlineDepth(parseInline("**_a_**"))).toBe(2);
    expect(maxInlineDepth(parseInline("[**a**](https://b.c)"))).toBe(2);
  });
  test("a nested paragraph keeps the whole tree shallow", () => {
    const [b] = parseMarkdown("*a ".repeat(10000) + "a* ".repeat(10000));
    expect(b.t).toBe("p");
    expect(maxInlineDepth((b as Extract<Block, { t: "p" }>).c)).toBeLessThanOrEqual(32);
  });
});

describe("fix round 1: bounded tables", () => {
  const cells = (t: Extract<Block, { t: "table" }>) => t.head.length + t.rows.reduce((n, r) => n + r.length, 0);
  test("2000 columns and 2000 rows are cut to 64 columns and 500 rows", () => {
    const cols = 2000;
    const head = "|" + Array.from({ length: cols }, (_, i) => ` c${i} `).join("|") + "|";
    const sep = "|" + Array.from({ length: cols }, () => "---").join("|") + "|";
    const src = [head, sep, ...Array.from({ length: 2000 }, () => "| 1 |")].join("\n");
    const start = performance.now();
    const [t] = parseMarkdown(src);
    expect(performance.now() - start).toBeLessThan(budget(1000));
    expect(t.t).toBe("table");
    const table = t as Extract<Block, { t: "table" }>;
    expect(cells(table)).toBeLessThanOrEqual(64 * 501);
    expect(table.head).toHaveLength(64);
    expect(table.align).toHaveLength(64);
    expect(table.rows).toHaveLength(500);
  });
  test("long rows are cut to the column cap even when the header is short", () => {
    const wide = "|" + Array.from({ length: 300 }, () => " x ").join("|") + "|";
    const [t] = parseMarkdown(["| a | b |", "|---|---|", wide].join("\n")) as [Extract<Block, { t: "table" }>];
    expect(t.rows[0]).toHaveLength(2);
  });
  test("a table cut short swallows its remaining rows instead of showing them as text", () => {
    const src = ["| a |", "|---|", ...Array.from({ length: 600 }, (_, i) => `| ${i} |`), "", "after"].join("\n");
    const out = parseMarkdown(src);
    expect(out.map((b) => b.t)).toEqual(["table", "p"]);
  });
});

describe("fix round 1: headings without backtracking", () => {
  test("a heading with a 100k-space run inside parses fast", () => {
    const start = performance.now();
    const [h] = parseMarkdown("# a" + " ".repeat(100_000) + "b");
    expect(performance.now() - start).toBeLessThan(budget(100));
    expect(h.t).toBe("h");
  });
  test("the same with a closing hash that is part of a word", () => {
    const start = performance.now();
    const [h] = parseMarkdown("# a" + " ".repeat(100_000) + "b #x");
    expect(performance.now() - start).toBeLessThan(budget(100));
    expect(h).toEqual({ t: "h", level: 1, c: [T("a" + " ".repeat(100_000) + "b #x")] });
  });
  test("a long whitespace run inside a paragraph line is fast too", () => {
    const start = performance.now();
    parseInline("a" + " ".repeat(100_000) + "b\nc");
    parseMarkdown("a" + " ".repeat(100_000) + "b\nc");
    expect(performance.now() - start).toBeLessThan(budget(200));
  });
  test("closing hashes and spacing are handled as before", () => {
    expect(parseMarkdown("## Title ##")).toEqual([{ t: "h", level: 2, c: [T("Title")] }]);
    expect(parseMarkdown("#   spaced   ")).toEqual([{ t: "h", level: 1, c: [T("spaced")] }]);
    expect(parseMarkdown("# #")).toEqual([{ t: "h", level: 1, c: [] }]);
    expect(parseMarkdown("#")).toEqual([{ t: "h", level: 1, c: [] }]);
    expect(parseMarkdown("### a#")).toEqual([{ t: "h", level: 3, c: [T("a#")] }]);
    expect(parseMarkdown("   # indented")).toEqual([{ t: "h", level: 1, c: [T("indented")] }]);
    expect(parseMarkdown("    # code-ish")[0].t).toBe("p");
  });
});

describe("fix round 1: paths and filenames stay literal", () => {
  test("a relative path with __dunder__ directories is not bold", () => {
    expect(parseInline("src/__tests__/a.test.ts")).toEqual([T("src/__tests__/a.test.ts")]);
    expect(parseInline("see src/__tests__/a.test.ts now")).toEqual([T("see src/__tests__/a.test.ts now")]);
  });
  test("an absolute path and a URL with __x__ stay literal", () => {
    expect(parseInline("/home/u/__x__/b")).toEqual([T("/home/u/__x__/b")]);
    expect(parseInline("https://x.dev/__a__/b")).toEqual([T("https://x.dev/__a__/b")]);
    expect(parseInline("go to https://x.dev/__a__/b, then")).toEqual([T("go to https://x.dev/__a__/b, then")]);
  });
  test("__init__.py and __main__.py are filenames, not bold", () => {
    expect(parseInline("__init__.py")).toEqual([T("__init__.py")]);
    expect(parseInline("run __main__.py now")).toEqual([T("run __main__.py now")]);
  });
  test("__bold__ and _italic_ still work", () => {
    expect(parseInline("__bold__ text")).toEqual([strong(T("bold")), T(" text")]);
    expect(parseInline("a _italic_ b")).toEqual([T("a "), em(T("italic")), T(" b")]);
    expect(parseInline("__bold__. Next")).toEqual([strong(T("bold")), T(". Next")]);
    expect(parseInline("snake_case_name")).toEqual([T("snake_case_name")]);
  });
  test("emphasis around a path still works", () => {
    expect(parseInline("**/tmp/a.png**")).toEqual([strong(T("/tmp/a.png"))]);
    expect(parseInline("_src/a.ts_")).toEqual([em(T("src/a.ts"))]);
  });
});

describe("fix round 1: plain-text fallback for a block", () => {
  const text = (src: string) => parseMarkdown(src).map(blockPlainText);
  test("keeps the words and drops the markup", () => {
    expect(text("## Title\n\nsome **bold** and `code` and [a link](https://b.c)")).toEqual(["Title", "some bold and code and a link"]);
  });
  test("code, quotes, lists, rules and tables come out as readable lines", () => {
    expect(text("```ts\nlet a = 1;\n```")).toEqual(["let a = 1;"]);
    expect(text("> quoted")).toEqual(["quoted"]);
    expect(text("- a\n- b")).toEqual(["a\nb"]);
    expect(text("---")).toEqual(["---"]);
    expect(text("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["a | b\n1 | 2"]);
  });
  test("a very deep inline source does not throw", () => {
    const out = parseMarkdown("*a ".repeat(10000) + "a* ".repeat(10000)).map(blockPlainText);
    expect(out[0].length).toBeGreaterThan(0);
  });
});

describe("fix round 2: hostile 100k-character inputs", () => {
  const SIZE = 100_000;
  const units: [string, string][] = [
    ["@", "@"],
    ["@a", "@a"],
    ["a.a.a.@", "a.a.a.@"],
    ["_", "_"],
    ["*", "*"],
    ["/", "/"],
    ["a/", "a/"],
    [".", "."],
    ["-", "-"],
    ["https://", "https://"],
    ["[", "["],
    ["backtick", "`"],
    ["backslash", "\\"],
    ["~", "~"],
    ["digits then slash", "12345/"],
  ];
  const hostile = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  test.each(units)("%s repeated finishes in under 250 ms in tokenize, parseInline and parseMarkdown", (_name, unit) => {
    const s = hostile(unit);
    expect(s).toHaveLength(SIZE);
    for (const [label, run] of [
      ["tokenize", () => tokenize(s)],
      ["parseInline", () => parseInline(s)],
      ["parseMarkdown", () => parseMarkdown(s)],
    ] as const) {
      const start = performance.now();
      run();
      expect(performance.now() - start, `${label} on ${JSON.stringify(unit)}`).toBeLessThan(budget(250));
    }
  });
});

describe("fix round 2: emphasis around URLs", () => {
  const url = "https://x.dev/a";
  test("bold, italic and strike around a bare URL", () => {
    expect(parseInline("**https://example.com**")).toEqual([strong(T("https://example.com"))]);
    expect(parseInline(`see **${url}** now`)).toEqual([T("see "), strong(T(url)), T(" now")]);
    expect(parseInline(`*${url}*`)).toEqual([em(T(url))]);
    expect(parseInline(`_${url}_`)).toEqual([em(T(url))]);
    expect(parseInline("~~https://x.dev~~")).toEqual([del(T("https://x.dev"))]);
    expect(parseInline(`__${url}__`)).toEqual([strong(T(url))]);
  });
  test("bold inside the text of a link", () => {
    expect(parseInline("[**https://x.dev**](https://x.dev)")).toEqual([link("https://x.dev", strong(T("https://x.dev")))]);
  });
  test("a URL followed by punctuation keeps both", () => {
    expect(parseInline(`go to **${url}**, then`)).toEqual([T("go to "), strong(T(url)), T(", then")]);
  });
  test("paths: emphasis around absolute, Windows and relative paths", () => {
    expect(parseInline("**/tmp/a.png**")).toEqual([strong(T("/tmp/a.png"))]);
    expect(parseInline("~~/tmp/a.png~~")).toEqual([del(T("/tmp/a.png"))]);
    expect(parseInline("see *C:\\a\\b.txt* now")).toEqual([T("see "), em(T("C:\\a\\b.txt")), T(" now")]);
    expect(parseInline("~~C:\\a\\b.txt~~")).toEqual([del(T("C:\\a\\b.txt"))]);
    expect(parseInline("**src/a.ts**")).toEqual([strong(T("src/a.ts"))]);
    expect(parseInline("_see /tmp/a.ts_")).toEqual([em(T("see /tmp/a.ts"))]);
  });
  test("URLs and paths with __x__ inside still stay literal", () => {
    expect(parseInline("https://x.dev/__a__/b")).toEqual([T("https://x.dev/__a__/b")]);
    expect(parseInline("src/__tests__/a.test.ts")).toEqual([T("src/__tests__/a.test.ts")]);
    expect(parseInline("**https://x.dev/__a__/b**")).toEqual([strong(T("https://x.dev/__a__/b"))]);
  });
  test("a trailing underscore that closes nothing stays in the text", () => {
    expect(parseInline("/pkg/__init__")).toEqual([T("/pkg/__init__")]);
    expect(parseInline("see /tmp/foo_ now")).toEqual([T("see /tmp/foo_ now")]);
  });
  test("relative path detection is unchanged for the plain cases", () => {
    expect(parseInline("a@b/c and x/y")).toEqual([T("a@b/c and x/y")]);
    expect(parseInline("-a/b __x__")).toEqual([T("-a/b "), strong(T("x"))]);
    expect(parseInline("see ./a/__b__/c ok")).toEqual([T("see ./a/__b__/c ok")]);
  });
});
