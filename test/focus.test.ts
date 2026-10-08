import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFocusPoller, focusChunk, focusDelay, focusEventOf, isForeignCwd, type PollerTimers } from "../src/focus";
import { defaultExec, focusEnv, Herdr, HerdrError, killTree, taskkillPath, TASKKILL_TIMEOUT_MS, type CurrentPane, type Exec, type HerdrLike, type PaneInfo } from "../src/herdr";
import { createServer } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";

/** Timers driven by hand: run() fires the due callbacks in time order. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: PollerTimers = {
    set: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: t + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  return {
    timers,
    pending: () => due.size,
    nextIn: () => (due.size ? Math.min(...[...due.values()].map((d) => d.at)) - t : null),
    /** Moves the clock by ms, firing what falls due (callbacks scheduled meanwhile too). */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        due.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        for (let i = 0; i < 30; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const pane = (id: string, over: Partial<CurrentPane> = {}): CurrentPane => ({
  paneId: id, agent: "claude", agentStatus: "idle", sessionId: `s-${id}`, cwd: "C:\\work", title: `t-${id}`, workspaceId: "w1", ...over,
});

describe("focusDelay", () => {
  test("the interval while all is well, doubling per error up to 5 s", () => {
    expect([0, 1, 2, 3, 4, 10, 99].map((f) => focusDelay(f))).toEqual([700, 1400, 2800, 5000, 5000, 5000, 5000]);
  });
});

describe("the focus poller", () => {
  test("polls only while active, every 700 ms, and reports only changes", async () => {
    const clock = fakeTimers();
    let active = true;
    let focused = "w1:p1";
    const seen: string[] = [];
    const p = createFocusPoller({ read: async () => pane(focused), active: () => active, changed: (x) => void seen.push(x.paneId), timers: clock.timers });
    p.wake();
    await clock.advance(0);
    expect(seen).toEqual(["w1:p1"]);
    expect(clock.nextIn()).toBe(700);
    await clock.advance(700 * 3);
    expect(p.reads()).toBe(4);
    expect(seen).toEqual(["w1:p1"]); // same pane: nothing new
    focused = "w2:p3";
    await clock.advance(700);
    expect(seen).toEqual(["w1:p1", "w2:p3"]);
    active = false;
    await clock.advance(700);
    expect(clock.pending()).toBe(0);
    expect(p.running()).toBe(false);
    const reads = p.reads();
    await clock.advance(10_000);
    expect(p.reads()).toBe(reads);
  });

  test("never reads while inactive (no window, or the setting is off); wake() starts it again", async () => {
    const clock = fakeTimers();
    let active = false;
    const p = createFocusPoller({ read: async () => pane("w1:p1"), active: () => active, changed: () => {}, timers: clock.timers });
    p.wake();
    await clock.advance(5000);
    expect(p.reads()).toBe(0);
    active = true;
    p.wake();
    await clock.advance(0);
    expect(p.reads()).toBe(1);
  });

  test("one read at a time: a slow herdr is never asked twice at once, however often wake() is called", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    let concurrent = 0;
    let most = 0;
    const p = createFocusPoller({
      read: async () => {
        concurrent++;
        most = Math.max(most, concurrent);
        await new Promise<void>((r) => (release = r));
        concurrent--;
        return pane("w1:p1");
      },
      active: () => true,
      changed: () => {},
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    for (let i = 0; i < 5; i++) p.wake({ soon: true });
    await clock.advance(3000);
    expect(p.reads()).toBe(1);
    expect(clock.pending()).toBe(1); // only the read's time limit: no next poll while the read is out
    release!();
    await flush();
    expect(clock.nextIn()).toBe(700); // the next poll is scheduled only now
    expect(most).toBe(1);
  });

  test("backs off on errors (1.4 s, 2.8 s, then 5 s) and returns to 700 ms after a success", async () => {
    const clock = fakeTimers();
    let fail = true;
    const p = createFocusPoller({
      read: async () => {
        if (fail) throw new HerdrError("socket not found");
        return pane("w1:p1");
      },
      active: () => true,
      changed: () => {},
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    const gaps: (number | null)[] = [clock.nextIn()];
    for (let i = 0; i < 3; i++) {
      await clock.advance(clock.nextIn()!);
      gaps.push(clock.nextIn());
    }
    expect(gaps).toEqual([1400, 2800, 5000, 5000]);
    fail = false;
    await clock.advance(5000);
    expect(p.failures()).toBe(0);
    expect(clock.nextIn()).toBe(700);
  });

  test("a pane that becomes a Claude pane is a change; stopping forgets, so starting again reports afresh", async () => {
    const clock = fakeTimers();
    let agent: string | null = null;
    let active = true;
    let idles = 0;
    const seen: string[] = [];
    const p = createFocusPoller({
      read: async () => pane("w7:p1", { agent }),
      active: () => active,
      changed: (x) => void seen.push(`${x.paneId}:${x.agent}`),
      idle: () => void idles++,
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    agent = "claude";
    await clock.advance(700);
    expect(seen).toEqual(["w7:p1:null", "w7:p1:claude"]);
    active = false;
    await clock.advance(700);
    expect(idles).toBeGreaterThan(0);
    active = true;
    p.wake();
    await clock.advance(0);
    expect(seen).toEqual(["w7:p1:null", "w7:p1:claude", "w7:p1:claude"]);
  });

  test("a read that never answers counts as a failure after its time limit, and polling goes on with backoff", async () => {
    const clock = fakeTimers();
    let hang = true;
    const p = createFocusPoller({
      read: () => (hang ? new Promise<CurrentPane>(() => {}) : Promise.resolve(pane("w1:p1"))),
      active: () => true,
      changed: () => {},
      timers: clock.timers,
      readTimeoutMs: 3000,
    });
    p.wake();
    await clock.advance(2999);
    expect(p.failures()).toBe(0);
    await clock.advance(1);
    expect(p.failures()).toBe(1);
    expect(clock.nextIn()).toBe(1400);
    hang = false;
    await clock.advance(1400);
    expect(p.failures()).toBe(0);
    expect(p.reads()).toBe(2);
  });

  test("a push that hangs is cut off the same way", async () => {
    const clock = fakeTimers();
    let n = 0;
    const p = createFocusPoller({
      read: async () => pane(`w1:p${++n}`),
      active: () => true,
      changed: () => new Promise<void>(() => {}),
      timers: clock.timers,
      readTimeoutMs: 1000,
    });
    p.wake();
    await clock.advance(1000 + 700 + 1000); // a hung push is not a read failure: the next poll comes 700 ms later
    expect(p.reads()).toBe(2);
  });

  test("wake({ soon }) cuts an error backoff short (a window arrived); a plain wake does not", async () => {
    const clock = fakeTimers();
    let fail = true;
    const p = createFocusPoller({
      read: async () => {
        if (fail) throw new HerdrError("socket not found");
        return pane("w1:p1");
      },
      active: () => true,
      changed: () => {},
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    await clock.advance(1400);
    await clock.advance(2800);
    expect(clock.nextIn()).toBe(5000);
    p.wake();
    expect(clock.nextIn()).toBe(5000);
    fail = false;
    p.wake({ soon: true });
    expect(clock.nextIn()).toBe(0);
    await clock.advance(0);
    expect(p.failures()).toBe(0);
  });

  test("a custom key decides what a change is (the server adds whether the transcript exists)", async () => {
    const clock = fakeTimers();
    let found = false;
    const seen: string[] = [];
    const p = createFocusPoller({
      read: async () => pane("w1:p1"),
      key: (x) => `${x.paneId}|${found}`,
      active: () => true,
      changed: (x) => void seen.push(x.paneId),
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(1400);
    found = true;
    await clock.advance(700);
    expect(seen).toEqual(["w1:p1", "w1:p1"]);
  });

  test("stop() while a read is in flight stops for good: no push, no next poll, wake() ignored", async () => {
    const clock = fakeTimers();
    let release: ((p: CurrentPane) => void) | null = null;
    const pushed: string[] = [];
    const p = createFocusPoller({
      read: () => new Promise<CurrentPane>((r) => (release = r)),
      active: () => true,
      changed: (x) => void pushed.push(x.paneId),
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    p.stop();
    release!(pane("w1:p1"));
    await flush();
    await clock.advance(10_000);
    p.wake();
    await clock.advance(10_000);
    expect(pushed).toEqual([]);
    expect(p.reads()).toBe(1);
    expect(p.running()).toBe(false);
  });

  test("a push that failed or timed out is tried again at the next poll, for the same pane", async () => {
    const clock = fakeTimers();
    let fail = 2;
    const pushed: string[] = [];
    const p = createFocusPoller({
      read: async () => pane("w1:p1"),
      active: () => true,
      changed: (x) => {
        if (fail-- > 0) throw new Error("workspace list failed");
        pushed.push(x.paneId);
      },
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(0);
    await clock.advance(700);
    expect(pushed).toEqual([]);
    await clock.advance(700);
    expect(pushed).toEqual(["w1:p1"]);
    await clock.advance(2100);
    expect(pushed).toEqual(["w1:p1"]); // reported once it went out
  });

  test("a throwing changed() does not stop polling", async () => {
    const clock = fakeTimers();
    let n = 0;
    const p = createFocusPoller({
      read: async () => pane(`w1:p${++n}`),
      active: () => true,
      changed: () => {
        throw new Error("push failed");
      },
      timers: clock.timers,
    });
    p.wake();
    await clock.advance(1400);
    expect(p.reads()).toBe(3);
  });
});

describe("focus events", () => {
  const deps = { platform: "win32", labels: new Map([["w1", "personal"]]), localMachine: "desk", hasTranscript: (s: string) => s === "s-w1:p1" };

  test("a local Claude pane: label for the workspace, transcript found or not", () => {
    expect(focusEventOf(pane("w1:p1"), deps)).toEqual({ paneId: "w1:p1", agent: "claude", isClaude: true, title: "t-w1:p1", workspace: "personal", remote: false, transcript: true });
    expect(focusEventOf(pane("w1:p2"), deps).transcript).toBe(false);
  });

  test("a plain terminal pane (no agent) and another agent: not Claude, no transcript asked", () => {
    let asked = 0;
    const d = { ...deps, hasTranscript: () => (asked++, true) };
    const plain = focusEventOf(pane("w7:p1", { agent: null, sessionId: null, title: "w7:p1", workspaceId: "w7" }), d);
    expect(plain).toEqual({ paneId: "w7:p1", agent: null, isClaude: false, title: "w7:p1", workspace: "w7", remote: false });
    expect(focusEventOf(pane("w1:p3", { agent: "codex" }), d).isClaude).toBe(false);
    expect(asked).toBe(0);
  });

  test("a Claude pane of another machine: by a POSIX cwd on Windows, or by a machine label herdr gives", () => {
    const posix = focusEventOf(pane("w1:p1A", { cwd: "/home/alice/vault" }), deps);
    expect(posix.remote).toBe(true);
    expect(posix.transcript).toBeUndefined();
    const named = focusEventOf(pane("w1:p1", { machine: "lab" }), deps);
    expect(named).toMatchObject({ remote: true, machine: "lab" });
    expect(focusEventOf(pane("w1:p1", { machine: "desk" }), deps).remote).toBe(false);
  });

  test("isForeignCwd: the other OS family's paths only", () => {
    expect(isForeignCwd("/home/alice", "win32")).toBe(true);
    expect(isForeignCwd("C:\\Users\\alice", "win32")).toBe(false);
    expect(isForeignCwd("\\\\server\\share", "win32")).toBe(false);
    expect(isForeignCwd("C:\\Users\\alice", "linux")).toBe(true);
    expect(isForeignCwd("/home/alice", "linux")).toBe(false);
    expect(isForeignCwd("", "win32")).toBe(false);
  });

  test("a failing transcript lookup counts as not found, never throws", () => {
    expect(focusEventOf(pane("w1:p1"), { ...deps, hasTranscript: () => { throw new Error("EACCES"); } }).transcript).toBe(false);
  });

  test("the SSE chunk is a named event", () => {
    expect(focusChunk(focusEventOf(pane("w1:p1"), deps))).toStartWith("event: focus\ndata: {");
  });
});

describe("Herdr.currentPane", () => {
  const exec = (stdout: string, code = 0) => {
    const calls: { cmd: string[]; env?: Record<string, string | undefined> }[] = [];
    const run: Exec = async (cmd, opts) => {
      calls.push({ cmd, ...(opts?.env ? { env: opts.env } : {}) });
      return { code, stdout, stderr: code ? "herdr: socket not found" : "" };
    };
    return { run, calls };
  };
  const current = (p: object) => JSON.stringify({ id: "cli:pane:current", result: { pane: p, type: "pane_current" } });
  // The real answer's shape (herdr 0.9.3), trimmed.
  const real = {
    agent: "claude",
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "0f8e3c2a" },
    agent_status: "working",
    cwd: "C:\\Users\\alice\\Vault",
    focused: true,
    pane_id: "w6:p4",
    tab_id: "w6:t4",
    terminal_title_stripped: "sidecr",
    workspace_id: "w6",
  };

  test("argv without a shell, and HERDR_PANE_ID removed from the environment (herdr would answer with that pane)", async () => {
    const { run, calls } = exec(current(real));
    const h = new Herdr(run, "herdr", { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/sock", PATH: "x" });
    const p = await h.currentPane();
    expect(calls[0]!.cmd).toEqual(["herdr", "pane", "current"]);
    expect(calls[0]!.env).toEqual({ HERDR_SOCKET_PATH: "/sock", PATH: "x" });
    expect(p).toEqual({ paneId: "w6:p4", agent: "claude", agentStatus: "working", sessionId: "0f8e3c2a", cwd: "C:\\Users\\alice\\Vault", title: "sidecr", workspaceId: "w6" });
  });

  test("a plain terminal pane: no agent, no session", async () => {
    const p = await new Herdr(exec(current({ agent_status: "unknown", cwd: "C:\\x", focused: true, pane_id: "w7:p1", workspace_id: "w7" })).run, "herdr", {}).currentPane();
    expect(p).toMatchObject({ paneId: "w7:p1", agent: null, sessionId: null, title: "w7:p1" });
  });

  test("a machine label in the answer is kept", async () => {
    expect((await new Herdr(exec(current({ ...real, machine: { label: "lab" } })).run, "herdr", {}).currentPane()).machine).toBe("lab");
  });

  test("errors: unreachable herdr, no pane, a pane that is not the focused one, output that is not JSON", async () => {
    await expect(new Herdr(exec("", 1).run, "herdr", {}).currentPane()).rejects.toThrow("socket not found");
    await expect(new Herdr(exec(JSON.stringify({ result: {} })).run, "herdr", {}).currentPane()).rejects.toBeInstanceOf(HerdrError);
    await expect(new Herdr(exec(current({ ...real, focused: false })).run, "herdr", {}).currentPane()).rejects.toThrow("not the focused one");
    await expect(new Herdr(exec("nope").run, "herdr", {}).currentPane()).rejects.toBeInstanceOf(HerdrError);
  });

  test("a pane current that never answers gives up after the time limit (an exec that ignores the limit too)", async () => {
    const seen: (number | undefined)[] = [];
    const never: Exec = async (_cmd, opts) => {
      seen.push(opts?.timeoutMs);
      return new Promise(() => {});
    };
    const t0 = Date.now();
    await expect(new Herdr(never, "herdr", {}, 100).currentPane()).rejects.toThrow("did not answer");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(seen).toEqual([100]);
  });

  test("defaultExec kills a child that runs past timeoutMs and reports a failure", async () => {
    const t0 = Date.now();
    const r = await defaultExec([process.execPath, "-e", "await Bun.sleep(20000)"], { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("did not answer in 300 ms");
  });

  test("killTree runs taskkill by its System32 path with a 2 s limit, then kills the child", () => {
    const calls: { cmd: string[]; opts: { timeout: number } }[] = [];
    const killed: unknown[] = [];
    killTree({ pid: 4242, kill: (sig) => void killed.push(sig) }, "win32", (cmd, opts) => void calls.push({ cmd, opts }), { SystemRoot: "D:\\Win" });
    expect(calls).toEqual([{ cmd: ["D:\\Win\\System32\\taskkill.exe", "/PID", "4242", "/T", "/F"], opts: { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 2000 } as never }]);
    expect(TASKKILL_TIMEOUT_MS).toBe(2000);
    expect(killed).toEqual(["SIGKILL"]);
    expect(taskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(taskkillPath({ windir: "E:\\W" })).toBe("E:\\W\\System32\\taskkill.exe");
  });

  test("killTree: a failing taskkill still kills the child; off Windows no taskkill at all", () => {
    const killed: unknown[] = [];
    killTree({ pid: 1, kill: (sig) => void killed.push(sig) }, "win32", () => {
      throw new Error("timed out");
    });
    let spawned = 0;
    killTree({ pid: 2, kill: (sig) => void killed.push(sig) }, "linux", () => void spawned++);
    expect(killed).toEqual(["SIGKILL", "SIGKILL"]);
    expect(spawned).toBe(0);
  });

  test("defaultExec without a limit leaves a quick child alone", async () => {
    const r = await defaultExec([process.execPath, "-e", "console.log('hi')"]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout.trim()).toBe("hi");
  });

  test("focusEnv drops only HERDR_PANE_ID and undefined entries", () => {
    expect(focusEnv({ HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", A: undefined, B: "b" })).toEqual({ HERDR_TAB_ID: "w1:t1", B: "b" });
  });
});

describe("the server's focus events", () => {
  const TOKEN = "tok-focus";
  const root = mkdtempSync(join(tmpdir(), "sidecr-focus-"));
  const projects = join(root, "projects");
  // The server runs with the real platform, so the local cwd (under the temp dir) is local there, and the foreign one
  // is written for the other OS family: a POSIX path on Windows, a drive path elsewhere.
  const cwd = join(root, "work");
  const foreignCwd = process.platform === "win32" ? "/home/alice/vault" : "C:\\Users\\alice\\vault";
  test("the cwds the tests use: the temp one is local, the other OS family's is foreign, on the platform in use", () => {
    expect(isForeignCwd(cwd, process.platform)).toBe(false);
    expect(isForeignCwd(foreignCwd, process.platform)).toBe(true);
  });
  mkdirSync(join(projects, encodeCwd(cwd)), { recursive: true });
  writeFileSync(join(projects, encodeCwd(cwd), "s1.jsonl"), JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) + "\n");
  mkdirSync(join(root, "ui"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);

  let focused: CurrentPane = { paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: "s1", cwd, title: "one", workspaceId: "w1" };
  let currentCalls = 0;
  let failCurrent = false;
  const herdr: HerdrLike = {
    getPane: async (id): Promise<PaneInfo> =>
      id === "w1:pR"
        ? { paneId: id, agent: "claude", agentStatus: "idle", sessionId: "sR", cwd: foreignCwd, title: "remote", workspaceId: "w1" }
        : { paneId: id, agent: "claude", agentStatus: "idle", sessionId: "s1", cwd, title: "one", workspaceId: "w1" },
    currentPane: async () => {
      currentCalls++;
      if (failCurrent) throw new HerdrError("socket not found");
      return focused;
    },
    listAgentPanes: async () => [],
    listWorkspaces: async () => [{ id: "w1", label: "personal" }],
    readScreen: async () => "",
    sendText: async () => {},
    sendKeys: async () => {},
  };
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: join(root, "att"), projectsRoot: projects, uiDir: join(root, "ui"), distDir: root,
    opener: async () => {}, stateDir, focusPollMs: 30, focusMaxBackoffMs: 60, platform: process.platform,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const H = { cookie: `sidecr=${TOKEN}` };
  afterAll(() => made.stop(true));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Reads an event stream in the background; text holds everything received so far. */
  async function open(win: string | null) {
    const ctrl = new AbortController();
    const res = await fetch(`${b}/api/events?pane=w1:p1${win ? `&win=${win}` : ""}`, { headers: H, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const out = { text: "", close: () => ctrl.abort() };
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.text += dec.decode(value);
        }
      } catch {
        /* aborted */
      }
    })();
    return out;
  }
  const events = (text: string) =>
    text
      .split("\n\n")
      .filter((c) => c.startsWith("event: focus"))
      .map((c) => JSON.parse(c.slice(c.indexOf("data: ") + 6)));

  test("no window, no polling: a stream without a window id does not start it", async () => {
    const s = await open(null);
    await wait(150);
    expect(currentCalls).toBe(0);
    expect(events(s.text)).toEqual([]);
    s.close();
  });

  test("a window's stream gets the focus at once, then only changes; another window id is not polled twice", async () => {
    const s = await open("win-a");
    await wait(120);
    expect(events(s.text)).toEqual([{ paneId: "w1:p1", agent: "claude", isClaude: true, title: "one", workspace: "personal", remote: false, transcript: true }]);
    focused = { paneId: "w7:p1", agent: null, agentStatus: "unknown", sessionId: null, cwd, title: "w7:p1", workspaceId: "w7" };
    await wait(120);
    focused = { paneId: "w1:pR", agent: "claude", agentStatus: "idle", sessionId: "sR", cwd: foreignCwd, title: "remote", workspaceId: "w1" };
    await wait(120);
    const got = events(s.text);
    expect(got.map((e) => [e.paneId, e.isClaude, e.remote])).toEqual([["w1:p1", true, false], ["w7:p1", false, false], ["w1:pR", true, true]]);
    // A second stream of the same window (a reconnect after a pane switch) learns the current focus straight away.
    const again = await open("win-a");
    await wait(20);
    expect(events(again.text).map((e) => e.paneId)).toEqual(["w1:pR"]);
    again.close();
    s.close();
  });

  test("followFocus off stops polling; on again starts it", async () => {
    const s = await open("win-b");
    await wait(80);
    await fetch(`${b}/api/settings`, { method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ followFocus: "off" }) });
    await wait(80);
    const before = currentCalls;
    await wait(200);
    expect(currentCalls).toBe(before);
    await fetch(`${b}/api/settings`, { method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ followFocus: "idle" }) });
    await wait(80);
    expect(currentCalls).toBeGreaterThan(before);
    s.close();
  });

  test("herdr unreachable: no event, the poll backs off, and recovers", async () => {
    const s = await open("win-c");
    await wait(80);
    const seen = events(s.text).length;
    failCurrent = true;
    const before = currentCalls;
    await wait(300);
    // 30 ms polls would be ~10 calls; the 60 ms cap keeps it to about 5.
    expect(currentCalls - before).toBeLessThanOrEqual(7);
    expect(events(s.text).length).toBe(seen);
    failCurrent = false;
    focused = { paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: "s1", cwd, title: "one", workspaceId: "w1" };
    await wait(150);
    expect(events(s.text).at(-1)!.paneId).toBe("w1:p1");
    s.close();
  });

  test("polling stops once no window is left", async () => {
    await wait(150); // the streams above are closed
    await wait(made.focus ? 100 : 0);
    // Windows that only opened a stream (no hello) leave the registry as their streams close.
    const before = currentCalls;
    await wait(200);
    expect(currentCalls).toBe(before);
    expect(made.focus!.running()).toBe(false);
  });

  test("a focus-only stream (the window's pane is gone) gets focus events without probing any pane", async () => {
    let probes = 0;
    const orig = herdr.getPane;
    herdr.getPane = async (id) => {
      probes++;
      return orig(id);
    };
    const ctrl = new AbortController();
    const res = await fetch(`${b}/api/events?win=win-f&focus=only`, { headers: H, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value);
        }
      } catch {
        /* aborted */
      }
    })();
    await wait(100);
    focused = { paneId: "w1:p9", agent: "claude", agentStatus: "idle", sessionId: "s1", cwd, title: "nine", workspaceId: "w1" };
    await wait(150);
    expect(events(text).at(-1)!.paneId).toBe("w1:p9");
    expect(text).not.toContain("data: changed");
    expect(probes).toBe(0);
    herdr.getPane = orig;
    ctrl.abort();
    expect((await fetch(`${b}/api/events?focus=only`, { headers: H })).status).toBe(400);
  });

  test("a Claude pane's transcript turning up is pushed as a new focus event", async () => {
    const s = await open("win-t");
    focused = { paneId: "w1:pN", agent: "claude", agentStatus: "idle", sessionId: "new-session", cwd, title: "new", workspaceId: "w1" };
    await wait(150);
    expect(events(s.text).at(-1)).toMatchObject({ paneId: "w1:pN", transcript: false });
    writeFileSync(join(projects, encodeCwd(cwd), "new-session.jsonl"), "{}\n");
    await wait(3500); // a miss is looked up again after 3 s
    expect(events(s.text).at(-1)).toMatchObject({ paneId: "w1:pN", transcript: true });
    s.close();
  }, 10000);

  test("a conversation of a pane whose cwd is another machine's says other-machine, not transcript-not-found", async () => {
    const res = await fetch(`${b}/api/conversation?pane=w1:pR`, { headers: H });
    expect(((await res.json()) as { error?: string }).error).toBe("other-machine");
  });
});

describe("stopping the server", () => {
  test("stop() also stops the focus poller, even with a window still registered", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidecr-focus-stop-"));
    mkdirSync(join(root, "ui"));
    let calls = 0;
    const herdr: HerdrLike = {
      getPane: async (id) => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: null, cwd: root, title: "t", workspaceId: "w1" }),
      currentPane: async () => (calls++, { paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: null, cwd: root, title: "t", workspaceId: "w1" }),
      listAgentPanes: async () => [],
      listWorkspaces: async () => [],
      readScreen: async () => "",
      sendText: async () => {},
      sendKeys: async () => {},
    };
    const made = createServer({ herdr, token: "t", attachmentsDir: join(root, "att"), uiDir: join(root, "ui"), distDir: root, opener: async () => {}, focusPollMs: 20 });
    const b = `http://127.0.0.1:${Number(made.server.port)}`;
    await fetch(`${b}/api/window`, { method: "POST", headers: { cookie: "sidecr=t", "content-type": "application/json" }, body: JSON.stringify({ id: "win-s", event: "hello" }) });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBeGreaterThan(0);
    made.stop(true);
    const at = calls;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(at);
    expect(made.focus!.running()).toBe(false);
  });
});

describe("an unreadable projects folder", () => {
  test("does not make every poll a failure: the focus event still goes out (transcript unknown, false)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidecr-focus-eacces-"));
    mkdirSync(join(root, "ui"));
    const notADir = join(root, "projects-file");
    writeFileSync(notADir, "x"); // readdirSync on it throws, like EACCES
    const herdr: HerdrLike = {
      getPane: async (id) => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: "s", cwd: root, title: "t", workspaceId: "w1" }),
      currentPane: async () => ({ paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: "s", cwd: root, title: "t", workspaceId: "w1" }),
      listAgentPanes: async () => [],
      listWorkspaces: async () => [],
      readScreen: async () => "",
      sendText: async () => {},
      sendKeys: async () => {},
    };
    const made = createServer({ herdr, token: "t", attachmentsDir: join(root, "att"), projectsRoot: notADir, uiDir: join(root, "ui"), distDir: root, opener: async () => {}, focusPollMs: 20, platform: process.platform });
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${Number(made.server.port)}/api/events?pane=w1:p1&win=win-x`, { headers: { cookie: "sidecr=t" }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    expect(text).toContain("event: focus");
    expect(made.focus!.failures()).toBe(0);
    ctrl.abort();
    made.stop(true);
  });
});
