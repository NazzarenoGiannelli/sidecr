import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exitCodeOf, launchOrExit3, OpenError } from "../src/launch";
import { chooseLauncher, findShell, forcedChromium, missingLauncher, openWindow, shellArgs } from "../src/shell";

const root = join("C:", "plugin");
const builtWin = join(root, "shell", "src-tauri", "target", "release", "sidecr-shell.exe");
const builtLinux = join(root, "shell", "src-tauri", "target", "release", "sidecr-shell");

describe("findShell", () => {
  test("the release build in the plugin directory, when it exists", () => {
    expect(findShell({ root, env: {}, exists: (p) => p === builtWin, platform: "win32" })).toBe(builtWin);
    expect(findShell({ root, env: {}, exists: (p) => p === builtLinux, platform: "linux" })).toBe(builtLinux);
  });
  test("null when it has not been built", () => {
    expect(findShell({ root, env: {}, exists: () => false, platform: "win32" })).toBeNull();
  });
  test("SIDECR_SHELL overrides the built one", () => {
    const env = { SIDECR_SHELL: "D:\\tools\\sidecr-shell.exe" };
    expect(findShell({ root, env, exists: () => true, platform: "win32" })).toBe("D:\\tools\\sidecr-shell.exe");
  });
  test("a SIDECR_SHELL that does not exist gives null, not the built one", () => {
    const env = { SIDECR_SHELL: "D:\\typo.exe" };
    expect(findShell({ root, env, exists: (p) => p === builtWin, platform: "win32" })).toBeNull();
  });
  test("an empty SIDECR_SHELL is ignored", () => {
    expect(findShell({ root, env: { SIDECR_SHELL: "  " }, exists: (p) => p === builtWin, platform: "win32" })).toBe(builtWin);
  });
});

describe("shellArgs", () => {
  test("the URL alone without bounds", () => {
    expect(shellArgs("http://localhost:1/?t=a&pane=w1%3Ap1", null)).toEqual(["--url", "http://localhost:1/?t=a&pane=w1%3Ap1"]);
  });
  test("bounds as separate flags, negative positions kept", () => {
    expect(shellArgs("http://x/", { x: -1500, y: 40, w: 600, h: 800 })).toEqual([
      "--url", "http://x/", "--x", "-1500", "--y", "40", "--w", "600", "--h", "800",
    ]);
  });
});

describe("chooseLauncher", () => {
  test("shell when found, Chromium otherwise", () => {
    expect(chooseLauncher({}, "C:\\s.exe")).toBe("shell");
    expect(chooseLauncher({}, null)).toBe("chromium");
  });
  test("SIDECR_LAUNCHER=chromium forces Chromium, any case", () => {
    expect(forcedChromium({ SIDECR_LAUNCHER: "Chromium" })).toBe(true);
    expect(chooseLauncher({ SIDECR_LAUNCHER: "chromium" }, "C:\\s.exe")).toBe("chromium");
    expect(chooseLauncher({ SIDECR_LAUNCHER: "shell" }, "C:\\s.exe")).toBe("shell");
  });
});

describe("openWindow", () => {
  // exit: what the spawned process's `exited` does: a code it resolves to soon, or "never" (a window that stays up).
  // exitDelayMs: how long after the spawn that exit code arrives.
  function harness(opts: { throwFor?: string; exit?: number | "never"; exitDelayMs?: number } = {}) {
    const spawns: { cmd: string[]; opts: Record<string, unknown> }[] = [];
    const browsers: { browser: string; url: string; dir: string; bounds: unknown }[] = [];
    let unrefs = 0;
    const spawn = ((cmd: string[], o: Record<string, unknown>) => {
      if (opts.throwFor && cmd[0] === opts.throwFor) throw new Error("ENOENT");
      spawns.push({ cmd, opts: o });
      const exit = opts.exit ?? "never";
      const exited = exit === "never" ? new Promise<number>(() => {}) : new Promise<number>((r) => setTimeout(() => r(exit), opts.exitDelayMs ?? 5));
      return { unref: () => void unrefs++, exited };
    }) as never;
    const launchBrowser = (browser: string, url: string, dir: string, bounds: unknown) => {
      browsers.push({ browser, url, dir, bounds });
    };
    return { spawns, browsers, spawn, launchBrowser, unrefs: () => unrefs };
  }
  const base = { url: "http://localhost:1/", dir: "C:\\state", bounds: { x: 1, y: 2, w: 600, h: 800 }, watchMs: 40 };

  test("spawns the shell detached, unref'd, without windowsHide, with the bounds; a shell that stays up is left alone", async () => {
    const h = harness();
    expect(await openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("shell");
    expect(h.browsers).toHaveLength(0);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.cmd).toEqual(["C:\\s.exe", "--url", "http://localhost:1/", "--x", "1", "--y", "2", "--w", "600", "--h", "800"]);
    expect(h.spawns[0]!.opts.detached).toBe(true);
    expect(h.spawns[0]!.opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect("windowsHide" in h.spawns[0]!.opts).toBe(false);
    expect(h.unrefs()).toBe(1);
  });

  test("a shell that exits non-zero right after starting (old binary, missing WebView2) falls back to Chromium", async () => {
    const h = harness({ exit: 2 });
    expect(await openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("chromium");
    expect(h.spawns).toHaveLength(1);
    expect(h.browsers).toHaveLength(1);
  });

  test("a shell that exits 0 right away handed over to the running one: no fallback", async () => {
    const h = harness({ exit: 0 });
    expect(await openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("shell");
    expect(h.browsers).toHaveLength(0);
  });

  test("a non-zero exit after the watch window does not open a second window", async () => {
    // The exit lands 200 ms after a 1 ms watch: far enough apart that timer jitter cannot reorder them.
    const h = harness({ exit: 2, exitDelayMs: 200 });
    expect(await openWindow({ ...base, watchMs: 1, env: {}, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("shell");
    expect(h.browsers).toHaveLength(0);
  });

  test("forced Chromium never touches the shell", async () => {
    const h = harness();
    expect(await openWindow({ ...base, env: { SIDECR_LAUNCHER: "chromium" }, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("chromium");
    expect(h.spawns).toHaveLength(0);
    expect(h.browsers).toEqual([{ browser: "C:\\edge.exe", url: base.url, dir: base.dir, bounds: base.bounds }]);
  });

  test("no shell: Chromium", async () => {
    const h = harness();
    expect(await openWindow({ ...base, env: {}, shell: null, browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("chromium");
    expect(h.browsers).toHaveLength(1);
  });

  test("a shell whose spawn throws falls back to Chromium", async () => {
    const h = harness({ throwFor: "C:\\s.exe" });
    expect(await openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: "C:\\edge.exe", spawn: h.spawn, launchBrowser: h.launchBrowser })).toBe("chromium");
    expect(h.browsers).toHaveLength(1);
  });

  test("the default browser launch goes through the same spawn (Chromium flags), without waiting", async () => {
    const h = harness();
    await openWindow({ ...base, env: {}, shell: null, browser: "C:\\edge.exe", spawn: h.spawn });
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.cmd[0]).toBe("C:\\edge.exe");
    expect(h.spawns[0]!.cmd.some((a) => a.startsWith("--app="))).toBe(true);
  });

  test("the Chromium fallback is watched too: a browser that dies with an error right after the shell did ends in an OpenError 6", async () => {
    const SH = "C:\\s.exe";
    const BR = "C:\\edge.exe";
    const calls: string[] = [];
    const spawn = ((cmd: string[]) => {
      calls.push(cmd[0]!);
      const dies = new Promise<number>((r) => setTimeout(() => r(cmd[0] === SH ? 2 : 1), 5));
      return { unref() {}, exited: dies, stderr: new Response("Failed to connect to Wayland display\n").body };
    }) as never;
    let caught: unknown = null;
    await openWindow({ ...base, env: {}, shell: SH, browser: BR, spawn }).catch((e) => (caught = e));
    expect(calls).toEqual([SH, BR]);
    expect(caught).toBeInstanceOf(OpenError);
    expect(exitCodeOf(caught)).toBe(6);
    expect((caught as OpenError).message).toBe("the browser exited early (code 1): Failed to connect to Wayland display");
  });

  test("spawnEnv reaches the shell and the browser spawns; without it no env is passed (the Windows default)", async () => {
    const SH = "C:\\s.exe";
    const BR = "C:\\edge.exe";
    const withEnv = harness();
    await openWindow({ ...base, env: {}, shell: SH, browser: BR, spawn: withEnv.spawn, spawnEnv: { DISPLAY: ":0" } });
    expect(withEnv.spawns[0]!.opts.env).toEqual({ DISPLAY: ":0" });
    const viaBrowser = harness();
    await openWindow({ ...base, env: {}, shell: null, browser: BR, spawn: viaBrowser.spawn, spawnEnv: { DISPLAY: ":0" } });
    expect(viaBrowser.spawns[0]!.opts.env).toEqual({ DISPLAY: ":0" });
    const plain = harness();
    await openWindow({ ...base, env: {}, shell: SH, browser: BR, spawn: plain.spawn });
    await openWindow({ ...base, env: {}, shell: null, browser: BR, spawn: plain.spawn });
    expect(plain.spawns.map((c) => "env" in c.opts)).toEqual([false, false]);
  });

  test("nothing to launch rejects", async () => {
    const h = harness({ throwFor: "C:\\s.exe" });
    await expect(openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: null, spawn: h.spawn, launchBrowser: h.launchBrowser })).rejects.toThrow(/no Chromium-family browser/);
    await expect(openWindow({ ...base, env: {}, shell: null, browser: null, spawn: h.spawn, launchBrowser: h.launchBrowser })).rejects.toThrow();
    const dies = harness({ exit: 3 });
    await expect(openWindow({ ...base, env: {}, shell: "C:\\s.exe", browser: null, spawn: dies.spawn, launchBrowser: dies.launchBrowser })).rejects.toThrow(/no Chromium-family browser/);
  });
});
describe("missingLauncher (the precheck in open.ts, before the server is started)", () => {
  test("a built shell is enough: no browser needed", () => {
    expect(missingLauncher({}, "C:\\s.exe", null)).toBeNull();
  });
  test("no shell and no browser: the exit-3 message", () => {
    expect(missingLauncher({}, null, null)).toMatch(/no Chromium-family browser found/);
  });
  test("forced Chromium without a browser fails even with a shell", () => {
    expect(missingLauncher({ SIDECR_LAUNCHER: "chromium" }, "C:\\s.exe", null)).toMatch(/no Chromium-family browser/);
  });
  test("a browser is always enough", () => {
    expect(missingLauncher({}, null, "C:\\edge.exe")).toBeNull();
    expect(missingLauncher({ SIDECR_LAUNCHER: "chromium" }, "C:\\s.exe", "C:\\edge.exe")).toBeNull();
  });
  test("open.ts uses it, and launches through launchOrExit3 and exits with exitCodeOf", async () => {
    const src = await Bun.file(new URL("../src/open.ts", import.meta.url)).text();
    expect(src).toContain("missingLauncher(process.env, shell, browser)");
    expect(src).toMatch(/await launchOrExit3\(\(\) => openWindow\(/);
    expect(src).toContain("process.exit(exitCodeOf(e))");
  });
});

describe("launchOrExit3 and exitCodeOf (the launch step of open.ts)", () => {
  test("a rejected launch becomes an OpenError whose exit code is 3, with the message kept", async () => {
    let caught: unknown = null;
    await launchOrExit3(() => Promise.reject(new Error("no Chromium-family browser found"))).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(OpenError);
    expect((caught as OpenError).message).toBe("no Chromium-family browser found");
    expect(exitCodeOf(caught)).toBe(3);
  });
  test("a real openWindow rejection (no shell, no browser) maps to exit 3", async () => {
    let caught: unknown = null;
    const launch = () => openWindow({ url: "http://localhost:1/", dir: "C:\\state", bounds: null, env: {}, shell: null, browser: null });
    await launchOrExit3(launch).catch((e) => (caught = e));
    expect(exitCodeOf(caught)).toBe(3);
  });
  test("an OpenError thrown by the launch (the browser exited early) keeps its own code and message", async () => {
    let caught: unknown = null;
    await launchOrExit3(() => Promise.reject(new OpenError("the browser exited early (code 1): x", 6))).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(OpenError);
    expect(exitCodeOf(caught)).toBe(6);
    expect((caught as OpenError).message).toBe("the browser exited early (code 1): x");
  });
  test("a launch that resolves does not throw", async () => {
    await launchOrExit3(() => Promise.resolve("shell"));
  });
  test("anything that is not an OpenError exits 1; an OpenError keeps its code", () => {
    expect(exitCodeOf(new Error("x"))).toBe(1);
    expect(exitCodeOf("x")).toBe(1);
    expect(exitCodeOf(new OpenError("no pane", 2))).toBe(2);
  });
});