import { describe, expect, test } from "bun:test";
import { collectPaths, hasFormatChar, tokenize } from "../src/links";
import { markdownPaths } from "../ui/markdown";

const values = (s: string) => tokenize(s).filter((t) => t.type === "path").map((t) => t.value);

// U+FEFF is the one format (Cf) character that JavaScript's \s also matches, so the Windows patterns used to stop before it and
// keep the prefix as a path: `C:\x\report.html<BOM>.txt` was an openable link to report.html. A format character right after a
// path, or inside it, drops the whole match.
describe("a format character right after a path drops the whole match", () => {
  const B = "\ufeff";
  test("U+FEFF after and inside Windows, POSIX and home paths: no token at all", () => {
    const cases = [
      `see C:\\x\\report.html${B}.txt now`,
      `see C:/x/report.html${B}.txt now`,
      `see C:\\x\\inv${B}txt.html now`,
      `see C:/x/inv${B}txt.html now`,
      `see C:\\x\\folder${B}`,
      `see C:\\x\\folder\\${B}`,
      `see /x/y/report.html${B}.txt now`,
      `see /x/y/inv${B}txt.html now`,
      `see ~/y/report.html${B}.txt now`,
      `see ~/y/inv${B}txt.html now`,
      `see ~/folder${B}`,
      // code spans, quotes and fences (no spaces, so the plain patterns decide)
      `\`C:\\x\\report.html${B}.txt\``,
      `\`/x/y/report.html${B}.txt\``,
      `\`~/y/report.html${B}.txt\``,
      `"C:\\x\\report.html${B}.txt"`,
      `'/x/y/report.html${B}.txt'`,
      `\u201c~/y/report.html${B}.txt\u201d`,
      `\`\`\`\nC:\\x\\report.html${B}.txt\n\`\`\``,
      `\`\`\`\n/x/y/report.html${B}.txt\n\`\`\``,
      `\`\`\`\n~/y/report.html${B}.txt\n\`\`\``,
    ];
    for (const text of cases) {
      expect(values(text), JSON.stringify(text)).toEqual([]);
      expect(collectPaths([{ id: "1", user: [{ kind: "text", text }], assistant: [] }]), JSON.stringify(text)).toEqual([]);
      // (the Markdown parser trims a BOM at the very end of a paragraph, so the window never shows it: nothing is hidden there)
      if (!text.endsWith(B)) {
        expect(markdownPaths(text), JSON.stringify(text)).toEqual([]);
        expect(collectPaths([{ id: "1", user: [], assistant: [{ kind: "text", text }] }]), JSON.stringify(text)).toEqual([]);
      }
    }
  });
  test("with spaces the plain pattern's own first words may stay, but never a token cut at the invisible character", () => {
    for (const text of [`\`C:\\x y\\report.html${B}.txt\``, `"/x y/report.html${B}.txt"`, `\`~/x y/inv${B}txt.html\``]) {
      for (const v of values(text)) expect(hasFormatChar(v), JSON.stringify(text)).toBe(false);
      expect(values(text).some((v) => v.endsWith("report.html") || v.endsWith("inv")), JSON.stringify(text)).toBe(false);
    }
  });
  test("a path followed by something else is unaffected", () => {
    expect(values("see C:\\x\\a.txt now")).toEqual(["C:\\x\\a.txt"]);
    expect(values("see C:\\x\\a.txt. Then C:\\y\\b.txt")).toEqual(["C:\\x\\a.txt", "C:\\y\\b.txt"]);
    expect(values(`${B}C:\\x\\a.txt`)).toEqual(["C:\\x\\a.txt"]); // the character is before the name, not in it
  });
  test("every Cf character right after a path, in every form, gives no token for that path", () => {
    const all: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (hasFormatChar(ch)) all.push(ch);
    }
    expect(all.length).toBeGreaterThan(150);
    expect(all).toContain(B);
    for (const c of all) {
      for (const text of [
        `see C:\\x\\a.html${c}`, `see C:\\x\\a.html${c} more`, `see C:/x/a.html${c}`, `see C:/x/a.html${c} more`,
        `see C:\\x\\folder${c}`, `see C:\\x\\folder\\${c}`, `see /x/y/a.html${c}`, `see /x/y/a.html${c} more`, `see ~/y/a.html${c}`, `see ~/folder${c} more`,
        `\`C:\\x\\a.html${c}\``, `"C:\\x\\a.html${c}"`, `\`\`\`\n/x/y/a.html${c}\n\`\`\``,
      ]) {
        const name = `U+${c.codePointAt(0)!.toString(16)} in ${JSON.stringify(text)}`;
        expect(values(text), name).toEqual([]);
        if (!text.endsWith(c)) expect(markdownPaths(text), `markdown ${name}`).toEqual([]); // a paragraph's trailing BOM is trimmed by the parser, so it is not displayed
      }
    }
  });
});
