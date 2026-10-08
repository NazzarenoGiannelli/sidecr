import { describe, expect, test } from "bun:test";
import type { TimerApi } from "../ui/timers";
import {
  CLOSE_REQUESTED_EVENT,
  createCloser,
  createInFlight,
  currentWindow,
  isShell,
  onCloseRequested,
  tauriOf,
  type TauriLike,
  type TauriWindowLike,
} from "../ui/shell";

function fakeWindow(opts: { destroyFails?: boolean } = {}) {
  const calls: string[] = [];
  const win: TauriWindowLike = {
    destroy: async () => {
      calls.push("destroy");
      if (opts.destroyFails) throw new Error("not allowed");
    },
    close: async () => {
      calls.push("close");
    },
    minimize: async () => {
      calls.push("minimize");
    },
  };
  return { win, calls };
}

function fakeTauri(win: TauriWindowLike, listen?: TauriLike["event"]): TauriLike {
  return { window: { getCurrentWindow: () => win }, event: listen };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function manualTimers() {
  const due: Array<{ fn: () => void; cleared: boolean }> = [];
  const timers: TimerApi = {
    set: (fn) => {
      const t = { fn, cleared: false };
      due.push(t);
      return t;
    },
    clear: (h) => {
      if (h) (h as { cleared: boolean }).cleared = true;
    },
  };
  const fire = () => due.filter((t) => !t.cleared).forEach((t) => t.fn());
  return { timers, fire, due };
}

describe("isShell", () => {
  test("true only with __TAURI__.window.getCurrentWindow", () => {
    const { win } = fakeWindow();
    expect(isShell({ __TAURI__: fakeTauri(win) })).toBe(true);
    expect(isShell({})).toBe(false);
    expect(isShell({ __TAURI__: {} })).toBe(false);
    expect(isShell({ __TAURI__: { window: {} } })).toBe(false);
    expect(isShell({ __TAURI__: { window: { getCurrentWindow: 1 } } })).toBe(false);
    expect(isShell(null)).toBe(false);
    expect(isShell(undefined)).toBe(false);
  });
  test("the real globalThis of the tests (no Tauri) is not the shell", () => {
    expect(isShell()).toBe(false);
    expect(currentWindow()).toBeNull();
  });
  test("currentWindow returns the window, or null when the API throws", () => {
    const { win } = fakeWindow();
    expect(currentWindow({ __TAURI__: fakeTauri(win) })).toBe(win);
    expect(currentWindow({ __TAURI__: { window: { getCurrentWindow: () => { throw new Error("x"); } } } })).toBeNull();
    expect(tauriOf({ __TAURI__: fakeTauri(win) })).not.toBeNull();
  });
});

describe("createCloser in the Chromium window", () => {
  test("unload steps first, then window.close()", () => {
    const log: string[] = [];
    const c = createCloser({ unload: () => log.push("unload"), win: null, closeBrowser: () => log.push("window.close") });
    c.close();
    expect(log).toEqual(["unload", "window.close"]);
  });
  test("every call still reaches window.close() (the runner itself runs once)", () => {
    const log: string[] = [];
    const c = createCloser({ unload: () => log.push("unload"), win: null, closeBrowser: () => log.push("window.close") });
    c.close();
    c.close();
    expect(log.filter((l) => l === "window.close")).toHaveLength(2);
  });
  test("a throwing unload does not stop the close", () => {
    const log: string[] = [];
    const c = createCloser({ unload: () => { throw new Error("x"); }, win: null, closeBrowser: () => log.push("window.close") });
    expect(() => c.close()).not.toThrow();
    expect(log).toEqual(["window.close"]);
  });
});

describe("createCloser in the shell", () => {
  test("unload, wait for the requests, then destroy; never window.close()", async () => {
    const { win, calls } = fakeWindow();
    const log: string[] = [];
    let release!: () => void;
    const settle = () => new Promise<void>((r) => (release = () => { log.push("settled"); r(); }));
    const c = createCloser({ unload: () => log.push("unload"), win, settle, closeBrowser: () => log.push("window.close") });
    c.close();
    await flush();
    expect(log).toEqual(["unload"]);
    expect(calls).toEqual([]); // still waiting for the bye
    release();
    await flush();
    expect(calls).toEqual(["destroy"]);
    expect(log).not.toContain("window.close");
  });
  test("two close paths at once destroy once", async () => {
    const { win, calls } = fakeWindow();
    let unloads = 0;
    const c = createCloser({ unload: () => unloads++, win, settle: async () => {}, closeBrowser: () => {} });
    c.close();
    c.close();
    await flush();
    await flush();
    expect(calls).toEqual(["destroy"]);
    expect(c.closing()).toBe(true);
    expect(unloads).toBe(2); // the real runner ignores the second call
  });
  test("a refused destroy falls back to close() (the shell's close request and timer)", async () => {
    const { win, calls } = fakeWindow({ destroyFails: true });
    const c = createCloser({ unload: () => {}, win, settle: async () => {}, closeBrowser: () => {} });
    c.close();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toEqual(["destroy", "close"]);
  });
  test("a settle that rejects still destroys", async () => {
    const { win, calls } = fakeWindow();
    const c = createCloser({ unload: () => {}, win, settle: () => Promise.reject(new Error("x")), closeBrowser: () => {} });
    c.close();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toEqual(["destroy"]);
  });
});

describe("createInFlight", () => {
  test("settled resolves at once with nothing tracked", async () => {
    const f = createInFlight(manualTimers().timers);
    let done = false;
    void f.settled(1000).then(() => (done = true));
    await flush();
    expect(done).toBe(true);
  });
  test("settled waits for every tracked request, failures included", async () => {
    const { timers } = manualTimers();
    const f = createInFlight(timers);
    let a!: () => void;
    let b!: (e: Error) => void;
    f.track(new Promise<void>((r) => (a = r)));
    f.track(new Promise<void>((_, rej) => (b = rej))).catch(() => {});
    let done = false;
    void f.settled(1000).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    a();
    await flush();
    expect(done).toBe(false);
    b(new Error("refused"));
    await flush();
    await flush();
    expect(done).toBe(true);
    expect(f.size()).toBe(0);
  });
  test("settled gives up after the timeout", async () => {
    const { timers, fire } = manualTimers();
    const f = createInFlight(timers);
    f.track(new Promise(() => {})); // never answers
    let done = false;
    void f.settled(1000).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    fire();
    await flush();
    expect(done).toBe(true);
  });
  test("track returns the original promise", async () => {
    const f = createInFlight(manualTimers().timers);
    expect(await f.track(Promise.resolve(42))).toBe(42);
  });
});

describe("onCloseRequested", () => {
  test("listens to the shell's event and calls the handler", async () => {
    const { win } = fakeWindow();
    const handlers = new Map<string, (e: unknown) => void>();
    const t = fakeTauri(win, { listen: async (name, h) => { handlers.set(name, h); return () => {}; } });
    let hits = 0;
    expect(await onCloseRequested(t, () => hits++)).toBe(true);
    handlers.get(CLOSE_REQUESTED_EVENT)!({ payload: null });
    expect(hits).toBe(1);
  });
  test("false without an event API, or when listen is refused", async () => {
    const { win } = fakeWindow();
    expect(await onCloseRequested(fakeTauri(win), () => {})).toBe(false);
    expect(await onCloseRequested(null, () => {})).toBe(false);
    const refused = fakeTauri(win, { listen: async () => { throw new Error("not allowed"); } });
    expect(await onCloseRequested(refused, () => {})).toBe(false);
  });
  test("the event name matches the one the Rust shell emits", async () => {
    const rust = await Bun.file(new URL("../shell/src-tauri/src/main.rs", import.meta.url)).text();
    expect(rust).toContain(`const CLOSE_REQUESTED_EVENT: &str = "${CLOSE_REQUESTED_EVENT}";`);
  });
});
