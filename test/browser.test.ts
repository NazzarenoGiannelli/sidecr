import { describe, expect, test } from "bun:test";
import { browserArgs, buildWindowUrl, findBrowser, launchAppWindow, stderrTail } from "../src/browser";
import { exitCodeOf, OpenError } from "../src/launch";
import { serverSpawnOptions } from "../src/state";

describe("findBrowser on Windows", () => {
  const env = { "ProgramFiles(x86)": "C:\\PF86", ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\Local" };
  test("prefers Edge, then Chrome", () => {
    const edge = "C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(findBrowser({ platform: "win32", env, exists: (p) => p === edge, which: () => null })).toBe(edge);
    const chrome = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    expect(findBrowser({ platform: "win32", env, exists: (p) => p === chrome, which: () => null })).toBe(chrome);
  });
  test("null when nothing is installed", () => {
    expect(findBrowser({ platform: "win32", env, exists: () => false, which: () => null })).toBeNull();
  });
});

describe("findBrowser on Linux", () => {
  test("uses the first of edge, chrome, chromium found on the PATH", () => {
    const which = (name: string) => (name === "google-chrome-stable" || name === "chromium" ? `/usr/bin/${name}` : null);
    expect(findBrowser({ platform: "linux", env: {}, exists: () => false, which })).toBe("/usr/bin/google-chrome-stable");
  });
  test("null when none is on the PATH", () => {
    expect(findBrowser({ platform: "linux", env: {}, exists: () => false, which: () => null })).toBeNull();
  });
});

test("buildWindowUrl carries the token and the pane id, encoded", () => {
  expect(buildWindowUrl({ pid: 1, port: 4321, token: "abc" }, "w1:p1")).toBe("http://localhost:4321/?t=abc&pane=w1%3Ap1");
});

/** The window speaks English whatever the system language is, and does not offer to translate the Italian conversation. */
const ENGLISH = ["--lang=en-US", "--disable-features=Translate"];

describe("browserArgs: English on every platform", () => {
  test("--lang=en-US and the translate prompt switched off, once each, on win32, linux and darwin, with and without bounds", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      for (const b of [null, { x: 1, y: 2, w: 600, h: 800 }]) {
        for (const exists of [false, true]) {
          const args = browserArgs("http://x/", "/state/profile", exists, b, platform);
          expect(args.filter((a) => a === "--lang=en-US")).toHaveLength(1);
          expect(args.filter((a) => a === "--disable-features=Translate")).toHaveLength(1);
        }
      }
    }
  });
  test("the existing arguments keep their order", () => {
    expect(browserArgs("http://x/", "/p", false, null, "win32").slice(0, 3)).toEqual(["--app=http://x/", "--user-data-dir=/p", "--no-first-run"]);
  });
});

describe("browserArgs", () => {
  test("first launch (no profile yet) forces the window size", () => {
    const args = browserArgs("http://x/", "/state/profile", false);
    expect(args).toContain("--window-size=520,760");
    expect(args).toContain("--app=http://x/");
    expect(args).toContain("--user-data-dir=/state/profile");
  });
  test("later launches leave the size to Chromium", () => {
    expect(browserArgs("http://x/", "/state/profile", true).some((a) => a.startsWith("--window-size"))).toBe(false);
  });
  test("saved bounds set position and size, on a first launch and on later ones", () => {
    for (const exists of [false, true]) {
      const args = browserArgs("http://x/", "/state/profile", exists, { x: 3226, y: 159, w: 600, h: 800 });
      expect(args).toContain("--window-position=3226,159");
      expect(args).toContain("--window-size=600,800");
      expect(args.filter((a) => a.startsWith("--window-size"))).toHaveLength(1);
    }
  });
  test("without bounds there is no position flag", () => {
    expect(browserArgs("http://x/", "/state/profile", false).some((a) => a.startsWith("--window-position"))).toBe(false);
    expect(browserArgs("http://x/", "/state/profile", true).some((a) => a.startsWith("--window-position"))).toBe(false);
  });
});

describe("browserArgs: the Linux profile directory (a unique Wayland app_id)", () => {
  const bounds = { x: 3226, y: 159, w: 600, h: 800 };
  const flag = "--profile-directory=Sidecr";
  test("linux includes the flag exactly once, with and without bounds", () => {
    for (const b of [null, bounds]) {
      for (const exists of [false, true]) {
        expect(browserArgs("http://x/", "/state/profile", exists, b, "linux").filter((a) => a === flag)).toHaveLength(1);
      }
    }
  });
  test("win32 and darwin do not get it, and their arguments are exactly what they were", () => {
    for (const platform of ["win32", "darwin"]) {
      expect(browserArgs("http://x/", "/state/profile", false, null, platform)).toEqual([
        "--app=http://x/", "--user-data-dir=/state/profile", "--no-first-run", ...ENGLISH, "--window-size=520,760",
      ]);
      expect(browserArgs("http://x/", "/state/profile", true, bounds, platform)).toEqual([
        "--app=http://x/", "--user-data-dir=/state/profile", "--no-first-run", ...ENGLISH, "--window-position=3226,159", "--window-size=600,800",
      ]);
    }
  });
  test("linux differs from win32 by that one flag only: the other arguments and their order are unchanged", () => {
    for (const exists of [false, true]) {
      const lin = browserArgs("http://x/", "/state/profile", exists, bounds, "linux");
      expect(lin.filter((a) => a !== flag)).toEqual(browserArgs("http://x/", "/state/profile", exists, bounds, "win32"));
    }
  });
  test("launchAppWindow passes the platform through to the spawned command", async () => {
    const calls: string[][] = [];
    const spawn = ((cmd: string[]) => {
      calls.push(cmd);
      return { unref() {} };
    }) as unknown as NonNullable<Parameters<typeof launchAppWindow>[4]>;
    await launchAppWindow("/usr/bin/chromium", "http://localhost:1/", "/state", null, spawn, 10, undefined, "linux");
    await launchAppWindow("C:\Edge\msedge.exe", "http://localhost:1/", "C:\state", null, spawn, 10, undefined, "win32");
    expect(calls[0]).toContain(flag);
    expect(calls[1]).not.toContain(flag);
  });
});

describe("launchAppWindow", () => {
  function captured() {
    const calls: { cmd: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = ((cmd: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, opts });
      return { unref() {} };
    }) as unknown as NonNullable<Parameters<typeof launchAppWindow>[4]>;
    return { calls, spawn };
  }

  test("the browser is spawned without windowsHide: SW_HIDE makes a fresh profile open a hidden window", async () => {
    const { calls, spawn } = captured();
    await launchAppWindow("C:\Edge\msedge.exe", "http://localhost:1/", "C:\state", null, spawn);
    expect(calls).toHaveLength(1);
    expect("windowsHide" in calls[0]!.opts).toBe(false);
    expect(calls[0]!.opts.detached).toBe(true);
    expect(calls[0]!.cmd[0]).toBe("C:\Edge\msedge.exe");
    expect(calls[0]!.cmd.some((a) => a.startsWith("--app="))).toBe(true);
  });

  test("the server, a console process, still starts hidden", () => {
    const opts = serverSpawnOptions(7, { A: "1" });
    expect(opts.windowsHide).toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 7, 7]);
    expect(opts.env).toEqual({ A: "1" });
  });
});

describe("launchAppWindow: watching the browser for an early exit", () => {
  type Child = { unref(): void; exited?: Promise<number | null>; stderr?: ReadableStream<Uint8Array> | null };
  const streamOf = (text: string) => new Response(text).body;
  function harness(child: Child | "throw") {
    const calls: { cmd: string[]; opts: Record<string, unknown> }[] = [];
    let unrefs = 0;
    const spawn = ((cmd: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, opts });
      if (child === "throw") throw new Error("ENOENT: spawn failed");
      return { ...child, unref: () => void unrefs++ };
    }) as unknown as NonNullable<Parameters<typeof launchAppWindow>[4]>;
    return { calls, spawn, unrefs: () => unrefs };
  }
  const run = (spawn: NonNullable<Parameters<typeof launchAppWindow>[4]>, watchMs = 60, env?: Record<string, string | undefined>) =>
    launchAppWindow("/usr/bin/chromium", "http://localhost:1/", "/state", null, spawn, watchMs, env);
  const delayed = (code: number, ms = 5) => new Promise<number>((r) => setTimeout(() => r(code), ms));

  test("spawned detached and unref'd, stdout ignored, stderr piped, no windowsHide", async () => {
    const h = harness({ unref() {}, exited: new Promise<number>(() => {}), stderr: streamOf("") });
    await run(h.spawn, 20);
    expect(h.calls[0]!.opts.stdio).toEqual(["ignore", "ignore", "pipe"]);
    expect(h.calls[0]!.opts.detached).toBe(true);
    expect("windowsHide" in h.calls[0]!.opts).toBe(false);
    expect("env" in h.calls[0]!.opts).toBe(false);
    expect(h.unrefs()).toBe(1);
  });
  test("an env is passed on only when given", async () => {
    const h = harness({ unref() {}, exited: new Promise<number>(() => {}) });
    await run(h.spawn, 20, { WAYLAND_DISPLAY: "wayland-1" });
    expect(h.calls[0]!.opts.env).toEqual({ WAYLAND_DISPLAY: "wayland-1" });
  });
  test("a browser still running after the window: untouched, silent success (even if it fails later)", async () => {
    const h = harness({ unref() {}, exited: delayed(1, 300), stderr: streamOf("late noise") });
    const t = Date.now();
    await run(h.spawn, 20);
    expect(Date.now() - t).toBeLessThan(250);
  });
  test("a browser that exits 0 quickly (handed to a running instance) is a silent success", async () => {
    const h = harness({ unref() {}, exited: delayed(0), stderr: streamOf("some warning on stderr") });
    await run(h.spawn);
  });
  test("a non-zero exit inside the window rejects with the code and the stderr tail (OpenError 6)", async () => {
    const h = harness({
      unref() {},
      exited: delayed(1),
      stderr: streamOf("[1:1:ERROR] first noise\n[1:1:ERROR] XDG_RUNTIME_DIR is invalid or not set\nFailed to connect to Wayland display\n"),
    });
    let caught: unknown = null;
    await run(h.spawn).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(OpenError);
    expect(exitCodeOf(caught)).toBe(6);
    expect((caught as OpenError).message).toBe(
      "the browser exited early (code 1): [1:1:ERROR] first noise | [1:1:ERROR] XDG_RUNTIME_DIR is invalid or not set | Failed to connect to Wayland display",
    );
  });
  test("a non-zero exit with nothing on stderr still says so", async () => {
    const h = harness({ unref() {}, exited: delayed(2), stderr: streamOf("") });
    await expect(run(h.spawn)).rejects.toThrow("the browser exited early (code 2)");
  });
  test("a child without stderr or exited (a spawn that cannot report) is left alone", async () => {
    await run(harness({ unref() {} }).spawn);
  });
  test("a spawn that throws rejects with its own error (the launch step maps it to exit 3)", async () => {
    await expect(run(harness("throw").spawn)).rejects.toThrow("ENOENT: spawn failed");
  });
  test("stderrTail keeps whole last lines up to ~300 characters, and the end of one huge line", () => {
    expect(stderrTail("a\n\n  b  \nc\n")).toBe("a | b | c");
    const lines = Array.from({ length: 40 }, (_, i) => `line number ${i} with some text`).join("\n");
    const t = stderrTail(lines);
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.endsWith("line number 39 with some text")).toBe(true);
    expect(t.startsWith("line number 39")).toBe(false);
    expect(stderrTail("x".repeat(1000) + "END")).toHaveLength(300);
    expect(stderrTail("x".repeat(1000) + "END").endsWith("END")).toBe(true);
    expect(stderrTail("")).toBe("");
    expect(stderrTail("a\u0000b\u001b[0m")).toBe("ab[0m");
  });
});
