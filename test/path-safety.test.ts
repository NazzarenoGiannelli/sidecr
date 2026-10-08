import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPaths, hasFormatChar, tokenize, tokenizeCode, tokenizeFenceBody, wholePathRange } from "../src/links";
import { parseDirTarget, realPathProblem, resolveOpen } from "../src/dirs";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { createServer } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";
import { parseMarkdown } from "../ui/markdown";
import { budget } from "./timing";

const values = (s: string) => tokenize(s).filter((t) => t.type === "path").map((t) => t.value);

describe("format characters (bidi controls, zero width) make a token not a path at all", () => {
  // U+202E reverses what follows: `inv<RLO>txt.html` reads as `invlmth.txt`. The same for the other invisible characters.
  const invisible = ["\u202e", "\u202a", "\u202b", "\u202c", "\u202d", "\u2066", "\u2067", "\u2068", "\u2069", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\ufeff", "\u2060", "\u2061", "\u2064", "\u00ad", "\u061c", "\udb40\udc01"];
  const holds = (v: string) => invisible.some((c) => v.includes(c));
  const forms = (c: string): [string, string][] => [
    ["Windows, no spaces, in prose", `see C:\\x\\inv${c}txt.html now`],
    ["Windows, forward slashes, in prose", `see C:/x/inv${c}txt.html now`],
    ["POSIX, in prose", `see /x/y/inv${c}txt.html now`],
    ["home, in prose", `see ~/y/inv${c}txt.html now`],
    ["Windows with spaces, in a code span", `\`C:\\x y\\inv${c}txt.html\``],
    ["POSIX with spaces, in a code span", `\`/x y/inv${c}txt.html\``],
    ["home with spaces, in a code span", `\`~/x y/inv${c}txt.html\``],
    ["in double quotes", `"C:\\x y\\inv${c}txt.html"`],
    ["in single quotes", `'/x y/inv${c}txt.html'`],
    ["in typographic quotes", `\u201c~/x y/inv${c}txt.html\u201d`],
    ["in a fence", `\`\`\`\n/x y/inv${c}txt.html\n\`\`\``],
    ["at the very end", `see /x/y/z.txt${c}`],
    ["at the very start", `see ${c}/x/y/z.txt`],
  ];
  test.each(invisible.map((c) => [JSON.stringify(c), c] as const))("%s is never inside a path token, in any form", (_n, c) => {
    for (const [label, text] of forms(c)) {
      for (const v of values(text)) expect(holds(v), `${label}: ${JSON.stringify(v)}`).toBe(false);
      for (const t of tokenizeCode(text)) if (t.type === "path") expect(holds(t.value), `code ${label}`).toBe(false);
      for (const t of tokenizeFenceBody(text)) if (t.type === "path") expect(holds(t.value), `fence ${label}`).toBe(false);
      const collected = collectPaths([{ id: "1", user: [{ kind: "text", text }], assistant: [{ kind: "text", text }] }]);
      for (const p of collected) expect(holds(p), `collected ${label}`).toBe(false);
    }
  });
  test("the token is dropped, not cut short into another path", () => {
    expect(values("see C:\\x\\inv\u202etxt.html now")).toEqual([]);
    expect(values("see /x/y/inv\u202etxt.html now")).toEqual([]);
    expect(values("see ~/y/inv\u202etxt.html now")).toEqual([]);
    expect(values("see C:/x/inv\u202etxt.html now")).toEqual([]);
    expect(values('"/x y/inv\u202etxt.html"')).toEqual([]);
    // the part before the space is the plain pattern's own token, which holds nothing invisible
    expect(values("`~/x y/inv\u200btxt.html`")).toEqual(["~/x"]);
    expect(values("```\n/x y/inv\ufefftxt.html\n```")).toEqual([]);
    // and the text around it still gives its own paths
    expect(values("/a/b.txt then /x/y/inv\u202etxt.html then /c/d.txt")).toEqual(["/a/b.txt", "/c/d.txt"]);
  });
  test("the quoted Windows form of the review: the part before the space is a path and holds nothing invisible", () => {
    expect(values('"C:\\x y\\inv\u202etxt.html"')).toEqual(["C:\\x"]);
    const s = "C:\\x y\\inv\u202etxt.html";
    expect(wholePathRange(s, 0, s.length)).toBeNull();
  });
  test("a path without invisible characters is unaffected, accents and combining marks included", () => {
    expect(values("`/x y/città e\u0301`")).toEqual(["/x y/città e\u0301"]);
    expect(hasFormatChar("/x/y")).toBe(false);
    expect(hasFormatChar("/x/\u202ey")).toBe(true);
    expect(hasFormatChar("/x/\udb40\udc01y")).toBe(true);
  });
});

describe("the server refuses invisible formatting characters in a target", () => {
  const tricky = "inv\u202etxt.html";
  test("parseDirTarget and realPathProblem", () => {
    for (const platform of ["win32", "linux"] as const) {
      const t = platform === "win32" ? `C:\\x\\${tricky}` : `/x/${tricky}`;
      expect(parseDirTarget(t, platform)).toMatchObject({ error: "bad-path" });
      expect(realPathProblem(t, platform)).not.toBeNull();
    }
    expect(parseDirTarget("/x/y\u200bz", "linux")).toMatchObject({ error: "bad-path" });
    expect(parseDirTarget("~/y\ufeffz", "linux")).toMatchObject({ error: "bad-path" });
  });

  const root = mkdtempSync(join(tmpdir(), "sidecr-safety-"));
  const projects = join(root, "projects");
  const uiDir = join(root, "ui");
  const distDir = join(root, "dist");
  mkdirSync(uiDir);
  mkdirSync(distDir);
  writeFileSync(join(uiDir, "index.html"), "<html></html>");
  const dir = join(root, "stuff");
  mkdirSync(dir);
  const page = join(dir, "page.html");
  writeFileSync(page, "<p>x</p>");
  const CWD = join(root, "work");
  mkdirSync(projects, { recursive: true });
  const sessionDir = join(projects, encodeCwd(CWD));
  mkdirSync(sessionDir, { recursive: true });
  const trick = join(dir, tricky);
  const stream = `${page}:evil.html`;
  // The conversation names all of them, and the tokenizer refuses the tricky ones, so a hand-made request is all that is left.
  writeFileSync(
    join(sessionDir, "sess-1.jsonl"),
    [
      { type: "user", uuid: "u1", message: { role: "user", content: "go" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `${page} ${dir} ${trick} ${stream}` }] } },
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
  const calls: { target: string; kind?: string }[] = [];
  const { server } = createServer({
    herdr, token: "tok-safety", attachmentsDir: join(root, "attachments"), projectsRoot: projects, uiDir, distDir,
    opener: async (target, kind) => void calls.push({ target, kind }),
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${Number(server.port)}`;
  const post = (body: unknown) =>
    fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie: "sidecr=tok-safety" } });

  test("a file, a folder and a reveal request with a bidi control are 400 bad-path, and nothing is opened", async () => {
    calls.length = 0;
    for (const kind of ["path", "dir", "reveal"]) {
      const res = await post({ pane: "w1:p1", kind, target: kind === "dir" ? `${dir}\u202e` : trick });
      expect(res.status, kind).toBe(400);
      expect(((await res.json()) as { error: string }).error, kind).toBe("bad-path");
    }
    expect(calls).toEqual([]);
  });
  test("the same request without the character opens (the check is what refuses it)", async () => {
    calls.length = 0;
    expect((await post({ pane: "w1:p1", kind: "path", target: page })).status).toBe(200);
    expect(calls).toEqual([{ target: page, kind: undefined }]);
  });
  test.skipIf(process.platform !== "win32")("on Windows a plain open of an alternate data stream is refused like a folder is", async () => {
    calls.length = 0;
    const res = await post({ pane: "w1:p1", kind: "path", target: stream });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("resolveOpen uses the Windows text rules whatever the host: a stream, a trailing dot, a quote, a network path", () => {
    const att = join(root, "attachments");
    const allowed = ["C:\\x\\a.html:s.html", "C:\\x\\a.html.", 'C:\\x\\"a.html', "\\\\srv\\share\\a.html", "C:\\x\\a.html"];
    for (const t of allowed.slice(0, 4)) expect(resolveOpen(t, allowed, att, "win32"), t).toMatchObject({ error: "bad-path" });
    expect(resolveOpen("C:\\x\\a.html", allowed, att, "win32")).toMatchObject({ error: "not-found" });
  });
});

describe("a colon is never inside an explicit path", () => {
  test("home and POSIX forms, whatever the platform: no alternate data stream gets onto the allow-list", () => {
    expect(values("`~/notes.txt:evil.html`")).toEqual(["~/notes.txt"]);
    expect(values("`/a b/notes.txt:evil.html`")).toEqual([]);
    expect(values('"~/x y/notes.txt:evil.html"')).toEqual(["~/x"]);
    expect(values("```\n/a b/c:d\n```")).toEqual([]);
    const s = "C:\\a b\\c:d";
    expect(wholePathRange(s, 0, s.length)).toBeNull();
  });
  test("a colon after the drive letter is in no token at all", () => {
    const text = "C:\\a\\b:c ~/a:b /a/b:c C:/a/b:c `~/x y/z:w` \"C:\\p q\\r:s\"";
    for (const t of tokenize(text)) if (t.type === "path") expect(t.value.slice(2).includes(":")).toBe(false);
  });
});

describe("hostile ` 'a` and friends: the single-quote closer search is linear", () => {
  const sizes = [20_000, 40_000, 80_000, 200_000];
  const time = (s: string) => {
    tokenize(s); // warm up
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      tokenize(s);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  for (const unit of [" 'a", " \u2018a", ' "a', " \u201ca", " 'a`", " 'a ", "'a' ", " \u2018a\u2019x", " `'a"]) {
    test(`${JSON.stringify(unit)} repeated stays linear`, () => {
      const t = sizes.map((n) => time(unit.repeat(Math.ceil(n / unit.length)).slice(0, n)));
      const note = t.map((x) => x.toFixed(1)).join(" / ");
      expect(t[3], `200k: ${note} ms`).toBeLessThan(budget(250));
      // 4x the input must not cost anything like 16x: a quadratic scan takes about 16x between 20k and 80k, a linear one about 4x.
      expect(t[2]! / Math.max(t[0]!, 1), `20k to 80k: ${note} ms`).toBeLessThan(9);
    });
  }
  test("the same through collectPaths and parseMarkdown", () => {
    const s = " 'a".repeat(70_000);
    for (const run of [() => collectPaths([{ id: "1", user: [], assistant: [{ kind: "text", text: s }] }]), () => parseMarkdown(s)]) {
      const t = performance.now();
      run();
      expect(performance.now() - t).toBeLessThan(budget(250));
    }
  });
});
