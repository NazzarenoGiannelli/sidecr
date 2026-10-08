import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { isAllowedDir, parseDirTarget, realPathProblem, resolveDir, resolveReveal } from "../src/dirs";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { createServer } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";

const TOKEN = "tok-dirs";
const win = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "sidecr-dirs-"));
const projects = join(root, "projects");
const uiDir = join(root, "ui");
const distDir = join(root, "dist");
mkdirSync(uiDir);
mkdirSync(distDir);
writeFileSync(join(uiDir, "index.html"), "<html></html>");
writeFileSync(join(distDir, "app.js"), "//js");

const dir = (...p: string[]) => {
  const d = join(root, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
const run1 = dir("out", "run1");
const run2 = dir("out", "run2");
const spaced = dir("out", "with space é");
const dotted = dir("out", "my.project");
const ws = dir("ws");
dir("ws", "sub");
dir("secret");
const shot = join(ws, "shot.png");
writeFileSync(shot, "PNG");
const plain = join(root, "plainfile"); // a file with no extension that the conversation calls a path
writeFileSync(plain, "x");
// Files of types that are never opened from a click: they may only be shown in their folder.
const refusedNames = ["run.exe", "run.bat", "run.cmd", "run.ps1", "run.sh", "run.msi", "run.lnk", "run.js", "run.jar", "run.url", "run.com", "run.hta", "run.vbs", "run.reg", "run.scr", "run.dll", "run.AppImage", "run.desktop", "data.zip"];
const refused = refusedNames.map((n) => {
  const f = join(dir("files"), n);
  writeFileSync(f, "x");
  return f;
});
// html and htm are the one script-capable pair that does open from a click (the user asked for it): the default app is the browser.
const htmlFiles = ["page.html", "page.htm"].map((n) => {
  const f = join(dir("files"), n);
  writeFileSync(f, "<p>x</p>");
  return f;
});
const gone = join(root, "gone");
const link = join(root, "linkdir");
const rootlink = join(root, "rootlink"); // a link to the drive or filesystem root, for the parent rule
let rootLinked = true;
try {
  symlinkSync(parse(root).root, rootlink, "junction");
} catch {
  rootLinked = false;
}
let linked = true;
try {
  symlinkSync(run1, link, "junction");
} catch {
  linked = false; // no right to make one here: the symlink test is skipped
}

const CWD = join(root, "work");
mkdirSync(projects, { recursive: true });
const sessionDir = join(projects, encodeCwd(CWD));
mkdirSync(sessionDir, { recursive: true });
const sep = win ? "\\" : "/";
const mention = [...refused, ...htmlFiles, join(rootlink, "a.txt"), run1, run2 + sep, dotted + sep, shot, plain, gone, link, spaced.replaceAll(" ", "")];
writeFileSync(
  join(sessionDir, "sess-1.jsonl"),
  [
    { type: "user", uuid: "u1", message: { role: "user", content: `folders ${mention.join(" ")} done` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n",
);

const pane = (id: string, sessionId: string | null): PaneInfo => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId, cwd: CWD, title: "t", workspaceId: "w1" });
const herdr: HerdrLike = {
  getPane: async (id) => pane(id, id === "w1:p1" ? "sess-1" : null),
  listAgentPanes: async () => [pane("w1:p1", "sess-1")],
  listWorkspaces: async () => [{ id: "w1", label: "personal" }],
  readScreen: async () => "",
  sendText: async () => {},
  sendKeys: async () => {},
};

const calls: { target: string; kind?: "dir" | "reveal" }[] = [];
let openerFails = false;
const { server } = createServer({
  herdr, token: TOKEN, attachmentsDir: join(root, "attachments"), projectsRoot: projects, uiDir, distDir,
  opener: async (target, kind) => {
    if (openerFails) throw new Error("no file manager");
    calls.push({ target, kind });
  },
});
const base = `http://127.0.0.1:${Number(server.port)}`;
afterAll(() => server.stop(true));

const post = (body: unknown, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) =>
  fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const openDir = (target: unknown, paneId = "w1:p1") => post({ pane: paneId, kind: "dir", target });

describe("POST /api/open kind dir: what opens", () => {
  test("a folder the conversation mentions opens, and the opener gets the real path and the dir kind", async () => {
    calls.length = 0;
    const res = await openDir(run1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ target: realpathSync(run1), kind: "dir" }]);
  });

  test("with or without the trailing separator it was written with", async () => {
    calls.length = 0;
    expect((await openDir(run2)).status).toBe(200);
    expect((await openDir(run2 + sep)).status).toBe(200);
    expect((await openDir(run1 + sep)).status).toBe(200);
    expect(calls.map((c) => c.target)).toEqual([realpathSync(run2), realpathSync(run2), realpathSync(run1)]);
  });

  test("a folder with a dot in its name, written with a trailing separator", async () => {
    calls.length = 0;
    expect((await openDir(dotted + sep)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("the folder holding a file the conversation mentions opens, one level only", async () => {
    calls.length = 0;
    expect((await openDir(ws)).status).toBe(200);
    expect(calls).toEqual([{ target: realpathSync(ws), kind: "dir" }]);
    // the folder inside it and the one above it were never shown
    expect((await openDir(join(ws, "sub"))).status).toBe(403);
    expect((await openDir(root)).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  test("forward slashes and a redundant segment name the same folder", async () => {
    calls.length = 0;
    expect((await openDir(run1.replaceAll("\\", "/"))).status).toBe(200);
    expect((await openDir(join(run1, "..", "run1"))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test.skipIf(!win)("Windows ignores case, like the file system", async () => {
    calls.length = 0;
    expect((await openDir(run1.toUpperCase())).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test.skipIf(win)("POSIX compares case-sensitively", async () => {
    expect((await openDir(run1.toUpperCase())).status).toBe(403);
  });

  test.skipIf(!linked)("a link to a folder opens the folder it leads to", async () => {
    calls.length = 0;
    expect((await openDir(link)).status).toBe(200);
    expect(calls).toEqual([{ target: realpathSync(run1), kind: "dir" }]);
  });

  test("a mention that was cut at a space opens only what was actually mentioned", async () => {
    // the conversation names "with space é" without the spaces: that spelling does not exist on disk
    const res = await openDir(spaced.replaceAll(" ", ""));
    expect(res.status).toBe(404);
    // the real folder, with spaces and an accent, was never mentioned
    expect((await openDir(spaced)).status).toBe(403);
  });
});

describe("POST /api/open kind dir: what is refused", () => {
  const err = async (res: Response, status: number, code: string) => {
    expect(res.status).toBe(status);
    const b = (await res.json()) as { error: string; message: string };
    expect(b.error).toBe(code);
    expect(typeof b.message).toBe("string");
  };

  test("a folder nobody mentioned is 403 forbidden and nothing is opened", async () => {
    calls.length = 0;
    await err(await openDir(join(root, "secret")), 403, "forbidden");
    await err(await openDir(tmpdir()), 403, "forbidden");
    await err(await openDir(parse(root).root), 403, "forbidden");
    expect(calls).toEqual([]);
  });

  test("a folder of another pane's session is forbidden (no session, no list)", async () => {
    await err(await openDir(run1, "w1:p2"), 403, "forbidden");
    await err(await post({ kind: "dir", target: run1 }), 403, "forbidden");
  });

  test("a mentioned folder that is gone is 404 not-found", async () => {
    await err(await openDir(gone), 404, "not-found");
  });

  test("a mentioned path that is a regular file is shown in its folder instead of opened: 200 with revealed", async () => {
    calls.length = 0;
    for (const f of [plain, shot]) {
      const res = await openDir(f);
      expect(res.status, f).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revealed: true });
    }
    // the opener was asked to reveal each, and never to open a folder or a file
    expect(calls).toEqual([plain, shot].map((f) => ({ target: realpathSync(f), kind: "reveal" })));
  });

  test("an extensionless file nobody mentioned is refused, not revealed", async () => {
    calls.length = 0;
    const noExt = join(dir("files"), "tool");
    writeFileSync(noExt, "x");
    // not in the conversation: refused
    await err(await openDir(noExt), 403, "forbidden");
    expect(calls).toEqual([]);
  });

  test.skipIf(win)("a path that is neither a file nor a folder (a fifo) stays 404", async () => {
    const fifo = join(root, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const r = resolveDir(fifo, [fifo]);
    expect(r).toMatchObject({ error: "not-found" });
  });

  test.skipIf(!rootLinked)("a link that leads to a drive or filesystem root does not open through a file's parent rule", async () => {
    calls.length = 0;
    await err(await openDir(rootlink), 403, "forbidden");
    expect(calls).toEqual([]);
    // the same link, mentioned itself, is what the conversation says: it opens
    expect(resolveDir(rootlink, [rootlink])).toEqual({ dir: realpathSync(rootlink) });
  });

  test("bad paths are 400 bad-path, before anything else is looked at", async () => {
    const bad: unknown[] = [
      "", "relative/folder", "folder", "./out", "~", "C:out", "file:///tmp/x",
      "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "//./pipe/x", "//?/C:/x",
      `${run1}\0`, `${run1}\nx`, `${run1}\x1b[0m`, "x".repeat(4097), `/${"a".repeat(4097)}`,
      7, null, {}, [run1],
    ];
    if (win) bad.push(`${run1}:stream`, `${run1}::$DATA`, "C:\\a:b", "\\rooted", "/rooted", `${run1}"x`, `${run1}.`, `${run1} `);
    calls.length = 0;
    for (const target of bad) await err(await openDir(target), 400, "bad-path");
    await err(await post({ pane: "w1:p1", kind: "dir" }), 400, "bad-path");
    expect(calls).toEqual([]);
  });

  test("a failing opener is a 500 answer, not a crash", async () => {
    openerFails = true;
    try {
      expect((await openDir(run1)).status).toBe(500);
    } finally {
      openerFails = false;
    }
    expect((await openDir(run1)).status).toBe(200);
  });

  test("the cookie and the JSON content type are still required", async () => {
    expect((await post({ pane: "w1:p1", kind: "dir", target: run1 }, {})).status).toBe(401);
    const res = await fetch(`${base}/api/open`, { method: "POST", body: "x", headers: { cookie: `sidecr=${TOKEN}`, "content-type": "text/plain" } });
    expect(res.status).toBe(415);
  });
});

describe("POST /api/open: files and URLs are unchanged", () => {
  test("a folder sent as a file is still refused as a type that is not opened", async () => {
    calls.length = 0;
    const res = await post({ pane: "w1:p1", kind: "path", target: run1 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "type-not-openable", message: "this file type is not opened from here" });
    expect(calls).toEqual([]);
  });
  test("a listed image opens as before, without the dir kind", async () => {
    calls.length = 0;
    expect((await post({ pane: "w1:p1", kind: "path", target: shot })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "url", target: "https://example.com" })).status).toBe(200);
    expect(calls).toEqual([{ target: shot, kind: undefined }, { target: "https://example.com", kind: undefined }]);
  });
});

describe("POST /api/open: html and htm open with the default app", () => {
  test("a mentioned html or htm file that exists is handed to the opener as a plain open", async () => {
    calls.length = 0;
    for (const f of htmlFiles) {
      const res = await post({ pane: "w1:p1", kind: "path", target: f });
      expect(res.status, f).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(calls).toEqual(htmlFiles.map((f) => ({ target: f, kind: undefined })));
  });
  test("the other gates still hold for it: mentioned in this pane's conversation, and it must exist", async () => {
    calls.length = 0;
    const unmentioned = join(root, "secret", "x.html");
    writeFileSync(unmentioned, "x");
    expect((await post({ pane: "w1:p1", kind: "path", target: unmentioned })).status).toBe(403);
    expect((await post({ pane: "w1:p2", kind: "path", target: htmlFiles[0] })).status).toBe(403);
    const missing = join(dirname(htmlFiles[0]!), "missing.html");
    expect((await post({ pane: "w1:p1", kind: "path", target: missing })).status).toBe(403); // not mentioned either
    const gonePage = join(dirname(htmlFiles[0]!), "page.htm");
    rmSync(gonePage);
    expect((await post({ pane: "w1:p1", kind: "path", target: gonePage })).status).toBe(404);
    writeFileSync(gonePage, "<p>x</p>");
    expect(calls).toEqual([]);
  });
  test("a script behind an html name does not get through: the last extension decides", async () => {
    calls.length = 0;
    const sneaky = join(dirname(htmlFiles[0]!), "page.html.exe");
    writeFileSync(sneaky, "x");
    expect((await post({ pane: "w1:p1", kind: "path", target: sneaky })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("parseDirTarget", () => {
  test("network shares, device prefixes and streams are refused on Windows rules", () => {
    for (const t of ["\\\\server\\share", "//server/share", "\\\\?\\C:\\x", "\\\\.\\C:\\x", "//?/C:/x", "\\/server/share", "/\\server\\share"]) {
      expect(parseDirTarget(t, "win32"), t).toMatchObject({ error: "bad-path" });
    }
    for (const t of ["C:\\a:stream", "C:\\a\\b:$DATA", "C:\\a::$DATA", "C::\\a", "C:\\a:"]) {
      expect(parseDirTarget(t, "win32"), t).toMatchObject({ error: "bad-path" });
    }
    for (const t of ["\\rooted", "/rooted", "C:", "C:rel", "rel\\x", "~", ""]) {
      expect(parseDirTarget(t, "win32"), t).toMatchObject({ error: "bad-path" });
    }
  });
  test("on Windows a double quote, and a trailing dot or space, are refused (Explorer gets the path in quotes)", () => {
    for (const t of ['C:\\a"b', 'C:\\a\\"x"', "C:\\a\\b.", "C:\\a\\b ", "C:\\a\\b. \\", "C:/a/b.", "C:\\a\\.."]) {
      expect(parseDirTarget(t, "win32"), t).toMatchObject({ error: "bad-path" });
    }
    // a comma is fine: the quoting keeps it inside the path
    expect(parseDirTarget("C:\\a\\b,c", "win32")).toHaveProperty("path");
  });
  test("UNC-looking and relative targets are refused on POSIX rules too", () => {
    for (const t of ["//server/share", "\\\\server\\share", "rel/x", "C:\\x", "~", "\\x"]) {
      expect(parseDirTarget(t, "linux"), t).toMatchObject({ error: "bad-path" });
    }
  });
  test("control characters and length, on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(parseDirTarget("/a/b\0c", platform)).toMatchObject({ error: "bad-path" });
      expect(parseDirTarget("C:\\a\\b\u0007", platform)).toMatchObject({ error: "bad-path" });
      expect(parseDirTarget("C:\\" + "a".repeat(4094), platform)).toMatchObject({ error: "bad-path" });
    }
  });
  test("~/ is expanded and an absolute path is resolved", () => {
    const p = parseDirTarget("~/folder");
    expect(p).toHaveProperty("path");
    expect(parseDirTarget(run1)).toEqual({ path: run1 });
    expect(parseDirTarget(win ? "C:\\a\\b\\..\\c" : "/a/b/../c")).toEqual({ path: win ? "C:\\a\\c" : "/a/c" });
  });
  test("colons are fine in POSIX names", () => {
    expect(parseDirTarget("/a/b:c", "linux")).toEqual({ path: win ? expect.any(String) : "/a/b:c" });
  });
});

describe("isAllowedDir", () => {
  const A = win ? "C:\\proj\\" : "/proj/";
  test("the folder itself, or the folder holding a file, in any spelling", () => {
    expect(isAllowedDir(`${A}out`, [`${A}out`])).toBe(true);
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}`])).toBe(true);
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}a.png`])).toBe(true);
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}.${sep}a.png`])).toBe(true);
  });
  test("only one level up from a file; never up from a folder candidate", () => {
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}deep${sep}a.png`])).toBe(false);
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}inner`])).toBe(false);
    expect(isAllowedDir(`${A}out`, [`${A}out${sep}inner${sep}`])).toBe(false);
  });
  test("a prefix of a name is not a match (anchored on a separator)", () => {
    expect(isAllowedDir(`${A}out`, [`${A}outside${sep}a.png`])).toBe(false);
    expect(isAllowedDir(`${A}out`, [`${A}outside`])).toBe(false);
    expect(isAllowedDir(`${A}outside`, [`${A}out`])).toBe(false);
  });
  test.skipIf(!win)("Windows compares without case", () => {
    expect(isAllowedDir("c:\\PROJ\\Out", ["C:\\proj\\out\\a.png"])).toBe(true);
  });
  test("a root is allowed only when it was mentioned itself", () => {
    const r = win ? "C:\\" : "/";
    expect(isAllowedDir(r, [`${r}a.png`])).toBe(false);
    expect(isAllowedDir(r, [`${r}a.png`, `${r}b`])).toBe(false);
    expect(isAllowedDir(r, [r])).toBe(true);
  });
});

describe("POST /api/open kind reveal: show a file in its folder, never open it", () => {
  const reveal = (target: unknown, paneId = "w1:p1") => post({ pane: paneId, kind: "reveal", target });
  const attachments = join(root, "attachments");

  test("a file whose type is refused for opening is revealed, and only revealed", async () => {
    calls.length = 0;
    for (const f of refused) {
      expect((await post({ pane: "w1:p1", kind: "path", target: f })).status, f).toBe(403);
      const res = await reveal(f);
      expect(res.status, f).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(calls).toEqual(refused.map((f) => ({ target: realpathSync(f), kind: "reveal" })));
  });

  test("executables and scripts are only ever revealed: no request shape opens them", async () => {
    calls.length = 0;
    const scripts = refused.filter((f) => !/\.zip$/.test(f));
    expect(scripts).toHaveLength(18);
    for (const f of scripts) {
      for (const kind of ["path", "file", "open", "run", undefined]) await post({ pane: "w1:p1", kind, target: f });
      await reveal(f);
    }
    expect(calls.filter((c) => c.kind !== "reveal")).toEqual([]);
    expect(calls).toHaveLength(scripts.length);
  });

  test("an allowed file type can be revealed too", async () => {
    calls.length = 0;
    expect((await reveal(shot)).status).toBe(200);
    expect(calls).toEqual([{ target: realpathSync(shot), kind: "reveal" }]);
  });

  test("it has the same gates as a file: mentioned in the conversation, and it must exist", async () => {
    calls.length = 0;
    expect((await reveal(join(root, "secret", "x.exe"))).status).toBe(403);
    expect((await reveal(join(root, "secret"))).status).toBe(403);
    expect((await reveal(refused[0], "w1:p2")).status).toBe(403);
    expect((await reveal(gone)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("the folder rule of one level up does not apply: a sibling nobody mentioned is not revealed", async () => {
    const sibling = join(ws, "never-mentioned.exe");
    writeFileSync(sibling, "x");
    expect((await reveal(sibling)).status).toBe(403);
  });

  test("bad paths are 400 bad-path", async () => {
    const bad: unknown[] = ["", "relative.exe", "\\\\server\\share\\a.exe", "//server/share/a.exe", "\\\\?\\C:\\a.exe", `${refused[0]}\0`, `${refused[0]}\n`, "x".repeat(4097), 5, null];
    if (win) bad.push(`${refused[0]}:stream`, `${refused[0]}"x`, `${refused[0]}.`);
    calls.length = 0;
    for (const t of bad) expect((await reveal(t)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a failing opener is a 500 answer", async () => {
    openerFails = true;
    try {
      expect((await reveal(refused[0])).status).toBe(500);
    } finally {
      openerFails = false;
    }
  });

  test("resolveReveal gives the real path of an allowed file and says why it refuses", () => {
    expect(resolveReveal(refused[0], [refused[0]!], attachments)).toEqual({ path: realpathSync(refused[0]!) });
    expect(resolveReveal(refused[0], [], attachments)).toMatchObject({ error: "forbidden" });
    expect(resolveReveal(gone, [gone], attachments)).toMatchObject({ error: "not-found" });
    expect(resolveReveal("rel.exe", [], attachments)).toMatchObject({ error: "bad-path" });
  });
});

describe("a path refused after realpath is a 400, not a failure of the opener", () => {
  test("the rules for the real path: control characters, network and device paths, and on Windows a quote or a trailing dot or space", () => {
    expect(realPathProblem("C:\\a\\b", "win32")).toBeNull();
    expect(realPathProblem("/a/b", "linux")).toBeNull();
    for (const p of ["C:\\a\\b.", "C:\\a\\b ", 'C:\\a"b', "C:\\a\u0007", "\\\\?\\C:\\a", "\\\\server\\share\\a", "//server/share/a"]) {
      expect(realPathProblem(p, "win32"), p).not.toBeNull();
    }
    for (const p of ["/a/b\nc", "/a/b\0", "//server/share"]) expect(realPathProblem(p, "linux"), p).not.toBeNull();
    // a dot or a space at the end is fine on POSIX
    expect(realPathProblem("/a/b.", "linux")).toBeNull();
  });
  test.skipIf(win)("a link to a folder whose real name has a control character is 400 bad-path (folder and reveal)", () => {
    const odd = join(root, "odd\nname");
    mkdirSync(odd);
    writeFileSync(join(odd, "f.txt"), "x");
    const lnk = join(root, "oddlink");
    symlinkSync(odd, lnk);
    const lnkFile = join(root, "oddfile");
    symlinkSync(join(odd, "f.txt"), lnkFile);
    expect(resolveDir(lnk, [lnk])).toMatchObject({ error: "bad-path" });
    expect(resolveReveal(lnkFile, [lnkFile], join(root, "attachments"))).toMatchObject({ error: "bad-path" });
  });
  test("a drive or filesystem root is never revealed (400)", () => {
    const r = parse(root).root;
    expect(resolveReveal(r, [r], join(root, "attachments"))).toMatchObject({ error: "bad-path" });
    if (rootLinked) expect(resolveReveal(rootlink, [rootlink], join(root, "attachments"))).toMatchObject({ error: "bad-path" });
  });
});

describe("resolveDir", () => {
  test("gives the real path, and says why when it refuses", () => {
    expect(resolveDir(run1, [run1])).toEqual({ dir: realpathSync(run1) });
    expect(resolveDir(run1, [])).toMatchObject({ error: "forbidden" });
    expect(resolveDir(gone, [gone])).toMatchObject({ error: "not-found" });
    expect(resolveDir(plain, [plain])).toEqual({ file: realpathSync(plain) });
    expect(resolveDir(plain, [`${plain}${sep}`])).toEqual({ file: realpathSync(plain) });
    expect(resolveDir("rel", [])).toMatchObject({ error: "bad-path" });
  });
  test("a file below a file is not a folder to open (not-found, not a crash)", () => {
    const below = join(plain, "x");
    expect(resolveDir(below, [below])).toMatchObject({ error: "not-found" });
  });
});
