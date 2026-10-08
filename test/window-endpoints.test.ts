import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { createServer } from "../src/server";

const TOKEN = "tok-win";
const root = mkdtempSync(join(tmpdir(), "sidecr-win-"));
const herdr: HerdrLike = {
  getPane: async (id): Promise<PaneInfo> => ({
    paneId: id, agent: "claude", agentStatus: "idle", sessionId: "s", cwd: root, title: "t", workspaceId: "w1",
  }),
  listAgentPanes: async () => [],
  listWorkspaces: async () => [],
  readScreen: async () => "",
  sendText: async () => {},
  sendKeys: async () => {},
};

describe("window registry endpoints", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeAll(() => { process.on("unhandledRejection", onUnhandled); });
  afterAll(() => { process.off("unhandledRejection", onUnhandled); });

  let clock = 5_000_000;
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: root, projectsRoot: join(root, "none"), uiDir: root, distDir: root,
    opener: async () => {}, now: () => clock,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  afterAll(() => made.server.stop(true));

  const JSON_HEADERS = { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" };
  const win = (id: unknown, event: unknown, headers: Record<string, string> = JSON_HEADERS) =>
    fetch(`${b}/api/window`, { method: "POST", headers, body: JSON.stringify({ id, event }) });
  const toggle = async (headers: Record<string, string> = JSON_HEADERS) => {
    const res = await fetch(`${b}/api/toggle`, { method: "POST", headers, body: JSON.stringify({ pane: "w1:p1" }) });
    return { status: res.status, body: (await res.json()) as { action?: string } };
  };
  /** Moves the clock far enough that every window and the opening marker from an earlier test have expired. */
  const reset = () => { clock += 100_000; };

  /** Reads an event stream in the background so a test can wait for a line, or look at everything that arrived so far. */
  async function openStream(query: string) {
    const ctl = new AbortController();
    const res = await fetch(`${b}/api/events?pane=w1:p1${query}`, { headers: { cookie: `sidecr=${TOKEN}` }, signal: ctl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const waker: { fn: (() => void) | null } = { fn: null };
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          waker.fn?.();
        }
      } catch {
        /* aborted by the test */
      }
    })();
    return {
      get text() { return text; },
      async waitFor(needle: string, ms = 3000): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`no ${JSON.stringify(needle)} in ${JSON.stringify(text)}`)), ms);
        });
        const found = (async () => {
          while (!text.includes(needle)) await new Promise<void>((r) => { waker.fn = r; });
        })();
        try {
          await Promise.race([found, deadline]);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel() { ctl.abort(); },
    };
  }

  test("both endpoints are 401 without the cookie and 403 for a wrong Host", async () => {
    expect((await win("a", "hello", { "content-type": "application/json" })).status).toBe(401);
    expect((await toggle({ "content-type": "application/json" })).status).toBe(401);
    expect((await win("a", "hello", { ...JSON_HEADERS, host: "evil.example" })).status).toBe(403);
    expect((await toggle({ ...JSON_HEADERS, host: "evil.example" })).status).toBe(403);
    reset();
    expect((await toggle()).body.action).toBe("open"); // nothing was registered by the refused calls
  });

  test("a GET is 405 on both", async () => {
    expect((await fetch(`${b}/api/window`, { headers: { cookie: `sidecr=${TOKEN}` } })).status).toBe(405);
    expect((await fetch(`${b}/api/toggle`, { headers: { cookie: `sidecr=${TOKEN}` } })).status).toBe(405);
  });

  test("another content type is 415 on both", async () => {
    for (const path of ["/api/window", "/api/toggle"]) {
      for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
        const res = await fetch(`${b}${path}`, {
          method: "POST", headers: { cookie: `sidecr=${TOKEN}`, "content-type": type }, body: JSON.stringify({ id: "a", event: "hello", pane: "p" }),
        });
        expect([path, type, res.status]).toEqual([path, type, 415]);
      }
    }
  });

  test("a cross-site write is 403 on both, a same-origin one passes", async () => {
    reset();
    for (const site of ["cross-site", "same-site"]) {
      expect((await win("xs", "hello", { ...JSON_HEADERS, "sec-fetch-site": site })).status).toBe(403);
      expect((await toggle({ ...JSON_HEADERS, "sec-fetch-site": site })).status).toBe(403);
    }
    expect((await toggle()).body.action).toBe("open"); // the refused calls registered nothing
    expect((await win("xs", "bye", { ...JSON_HEADERS, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await toggle({ ...JSON_HEADERS, "sec-fetch-site": "none" })).status).toBe(200);
  });

  test("a bad id or event on /api/window is 400 and registers nothing", async () => {
    reset();
    for (const id of ["", "has space", "x".repeat(65), "a/b", "a_b", 7, null, undefined, ["a"], { a: 1 }]) {
      const res = await win(id, "hello");
      expect([String(id), res.status]).toEqual([String(id), 400]);
    }
    for (const event of ["", "HELLO", "open", 1, null, undefined]) {
      expect([String(event), (await win("good-id", event)).status]).toEqual([String(event), 400]);
    }
    for (const body of ["{nope", "", "null", "[]", "7", '"hello"']) {
      const res = await fetch(`${b}/api/window`, { method: "POST", headers: JSON_HEADERS, body });
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect((await toggle()).body.action).toBe("open"); // no window came out of all that
  });

  test("a bad body on /api/toggle is 400 and changes nothing", async () => {
    reset();
    for (const body of ["{nope", "", "null", "[]", "7", '"x"', JSON.stringify({ pane: 7 })]) {
      const res = await fetch(`${b}/api/toggle`, { method: "POST", headers: JSON_HEADERS, body });
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect((await toggle()).body.action).toBe("open"); // the first valid call finds nothing open
  });

  test("toggle opens, then closes, then opens again over HTTP", async () => {
    reset();
    expect(await toggle()).toEqual({ status: 200, body: { action: "open" } });
    expect((await win("w-one", "hello")).status).toBe(200);
    expect(await toggle()).toEqual({ status: 200, body: { action: "close" } });
    expect((await win("w-one", "bye")).status).toBe(200);
    expect((await toggle()).body.action).toBe("open");
  });

  test("a second press within 6 s of an open answer closes; later it opens again", async () => {
    reset();
    expect((await toggle()).body.action).toBe("open");
    clock += 5000;
    expect((await toggle()).body.action).toBe("close");
    expect((await toggle()).body.action).toBe("open");
    clock += 6000;
    expect((await toggle()).body.action).toBe("open");
  });

  test("a window that stops pinging is gone after 9 s; a ping keeps it", async () => {
    reset();
    await win("w-ping", "hello");
    clock += 8000;
    await win("w-ping", "ping");
    clock += 8000;
    expect((await toggle()).body.action).toBe("close");
    reset();
    await win("w-silent", "hello");
    clock += 9000;
    expect((await toggle()).body.action).toBe("open");
  });

  test("toggle close pushes data: close to an alive window's stream", async () => {
    reset();
    const s = await openStream("&win=w-sse");
    try {
      await s.waitFor("data: changed");
      await win("w-sse", "hello");
      expect((await toggle()).body.action).toBe("close");
      await s.waitFor("data: close\n\n");
    } finally {
      s.cancel();
    }
  });

  test("toggle open pushes nothing", async () => {
    reset();
    const s = await openStream("&win=w-quiet");
    try {
      await s.waitFor("data: changed");
      expect((await toggle()).body.action).toBe("open");
      await win("w-quiet-other", "ping"); // a round trip after the toggle: anything it pushed is in the stream by now
      expect(s.text).not.toContain("data: close");
    } finally {
      s.cancel();
    }
  });

  test("a hello from a second window tells the first to close, not itself", async () => {
    reset();
    const first = await openStream("&win=w-first");
    const second = await openStream("&win=w-second");
    try {
      await first.waitFor("data: changed");
      await second.waitFor("data: changed");
      await win("w-first", "hello");
      expect(first.text).not.toContain("data: close");
      await win("w-second", "hello");
      await first.waitFor("data: close\n\n");
      expect(second.text).not.toContain("data: close");
    } finally {
      first.cancel();
      second.cancel();
    }
  });

  test("a repeated hello (a reload) of the only window does not close it", async () => {
    reset();
    const s = await openStream("&win=w-reload");
    try {
      await s.waitFor("data: changed");
      await win("w-reload", "hello");
      await win("w-reload", "hello");
      await win("w-other-ping", "ping"); // a request after the hellos
      expect(s.text).not.toContain("data: close");
    } finally {
      s.cancel();
    }
  });

  test("a stream without win works as before and is not closed by a toggle", async () => {
    reset();
    const plain = await openStream("");
    const named = await openStream("&win=w-named");
    try {
      await plain.waitFor("data: changed");
      await win("w-named", "hello");
      expect((await toggle()).body.action).toBe("close");
      await named.waitFor("data: close\n\n");
      expect(plain.text).not.toContain("data: close");
    } finally {
      plain.cancel();
      named.cancel();
    }
  });

  test("a stream with an invalid win value is refused with 400", async () => {
    const res = await fetch(`${b}/api/events?pane=w1:p1&win=${encodeURIComponent("bad id!")}`, { headers: { cookie: `sidecr=${TOKEN}` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("bad-window");
  });

  test("two streams of one window (a pane switch reconnects): one ending leaves the other, which gets the close", async () => {
    reset();
    const old = await openStream("&win=w-two");
    const next = await openStream("&win=w-two");
    try {
      await old.waitFor("data: changed");
      await next.waitFor("data: changed");
      old.cancel();
      await win("w-two", "hello");
      expect((await toggle()).body.action).toBe("close");
      await next.waitFor("data: close\n\n");
    } finally {
      old.cancel();
      next.cancel();
    }
  });

  test("a window with a connected stream is alive even when its pings stopped (a minimised window's timers are throttled)", async () => {
    reset();
    const s = await openStream("&win=w-throttled");
    try {
      await s.waitFor("data: changed");
      await win("w-throttled", "hello");
      clock += 60_000; // no pings for a minute
      expect((await toggle()).body.action).toBe("close");
      await s.waitFor("data: close\n\n");
    } finally {
      s.cancel();
    }
  });

  test("a hello closes an earlier window that only its stream keeps alive", async () => {
    reset();
    const old = await openStream("&win=w-old");
    try {
      await old.waitFor("data: changed");
      await win("w-old", "hello");
      clock += 60_000;
      await win("w-new", "hello");
      await old.waitFor("data: close\n\n");
    } finally {
      old.cancel();
    }
  });

  test("a stream does not keep alive a window that said bye or never said hello", async () => {
    reset();
    const s = await openStream("&win=w-bye");
    const t = await openStream("&win=w-never");
    try {
      await s.waitFor("data: changed");
      await t.waitFor("data: changed");
      await win("w-bye", "hello");
      await win("w-bye", "bye"); // its stream is still connected for a moment
      expect((await toggle()).body.action).toBe("open");
      expect(s.text).not.toContain("data: close");
      expect(t.text).not.toContain("data: close");
    } finally {
      s.cancel();
      t.cancel();
    }
  });

  const answer = async (res: Response) => (await res.json()) as { ok?: boolean; close?: boolean };

  test("hello, ping and bye answer { ok: true, close: false } when nothing asked the window to close", async () => {
    reset();
    expect(await answer(await win("w-plain", "hello"))).toEqual({ ok: true, close: false });
    expect(await answer(await win("w-plain", "ping"))).toEqual({ ok: true, close: false });
    expect(await answer(await win("w-plain", "bye"))).toEqual({ ok: true, close: false });
  });

  test("a window without a stream gets close: true on its next ping after a toggle close, once", async () => {
    reset();
    await win("w-nostream", "hello");
    expect((await toggle()).body.action).toBe("close");
    expect(await answer(await win("w-nostream", "ping"))).toEqual({ ok: true, close: true });
    expect(await answer(await win("w-nostream", "ping"))).toEqual({ ok: true, close: false }); // cleared after delivery
  });

  test("a window whose stream was dropped (disconnected, or ended after gone) is still closed by the next ping", async () => {
    reset();
    const s = await openStream("&win=w-dropped");
    await s.waitFor("data: changed");
    await win("w-dropped", "hello");
    s.cancel();
    while (made.stats.sse > 0) await new Promise((r) => setTimeout(r, 5)); // the server noticed the stream ended
    expect((await toggle()).body.action).toBe("close");
    expect(await answer(await win("w-dropped", "ping"))).toEqual({ ok: true, close: true });
  });

  test("a hello that finds the flag set also answers close: true", async () => {
    reset();
    await win("w-rehello", "hello");
    await toggle();
    expect(await answer(await win("w-rehello", "hello"))).toEqual({ ok: true, close: true });
  });

  test("a window that registered after the toggle is not asked to close", async () => {
    reset();
    await win("w-before", "hello");
    expect((await toggle()).body.action).toBe("close");
    expect(await answer(await win("w-after", "hello"))).toEqual({ ok: true, close: false });
    expect(await answer(await win("w-after", "ping"))).toEqual({ ok: true, close: false });
  });

  test("a hello from a newer window closes an older one that has no stream, through the older one's next ping", async () => {
    reset();
    await win("w-old-nostream", "hello");
    expect(await answer(await win("w-newer", "hello"))).toEqual({ ok: true, close: false });
    expect(await answer(await win("w-newer", "ping"))).toEqual({ ok: true, close: false });
    expect(await answer(await win("w-old-nostream", "ping"))).toEqual({ ok: true, close: true });
  });

  test("toggle (open), hello, bye, toggle opens again: the hello consumed the opening marker", async () => {
    reset();
    expect((await toggle()).body.action).toBe("open");
    await win("w-arrived", "hello");
    await win("w-arrived", "bye");
    expect((await toggle()).body.action).toBe("open");
  });

  test("a second press while the window is still launching: the hello of the window that arrives answers close: true", async () => {
    reset();
    expect((await toggle()).body.action).toBe("open");
    clock += 2000;
    expect((await toggle()).body.action).toBe("close");
    expect(await answer(await win("w-launching", "hello"))).toEqual({ ok: true, close: true });
    expect(await answer(await win("w-launching", "bye"))).toEqual({ ok: true, close: false });
    expect((await toggle()).body.action).toBe("open");
  });

  test("a ping that lands after the bye does not bring the window back", async () => {
    reset();
    await win("w-ghost", "hello");
    await win("w-ghost", "bye");
    await win("w-ghost", "ping"); // in flight during pagehide
    expect((await toggle()).body.action).toBe("open");
  });

  test("closing a window whose stream already ended raises nothing", async () => {
    reset();
    unhandled.length = 0;
    const s = await openStream("&win=w-gone");
    await s.waitFor("data: changed");
    await win("w-gone", "hello");
    s.cancel();
    while (made.stats.sse > 0) await new Promise((r) => setTimeout(r, 5)); // until the server has noticed the stream ended
    expect((await toggle()).body.action).toBe("close"); // the window is still registered: its close push finds no stream
    await win("w-gone2", "hello"); // and so does a hello that asks it to close
    expect(unhandled).toEqual([]);
  });
});
