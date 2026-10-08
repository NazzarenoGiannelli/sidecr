import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_API_VERSION } from "../src/version";
import { ensureServer, healthOf, isHealthy, readInfo, removeInfo, removeInfoIfOwner, writeInfo, type ServerInfo } from "../src/state";

const dir = () => mkdtempSync(join(tmpdir(), "sidecr-state-"));

describe("server info file", () => {
  test("round trip and removal", () => {
    const d = dir();
    const info: ServerInfo = { pid: 1, port: 5555, token: "t" };
    writeInfo(d, info);
    expect(readInfo(d)).toEqual(info);
    removeInfo(d);
    expect(readInfo(d)).toBeNull();
  });
  test("removeInfoIfOwner removes only the file written by that pid", () => {
    const d = dir();
    writeInfo(d, { pid: 111, port: 5555, token: "t" });
    removeInfoIfOwner(d, 222);
    expect(readInfo(d)).not.toBeNull();
    removeInfoIfOwner(d, 111);
    expect(readInfo(d)).toBeNull();
    removeInfoIfOwner(d, 111); // already gone: no error
  });
  test("corrupt file reads as null", () => {
    const d = dir();
    writeFileSync(join(d, "server.json"), "{nope");
    expect(readInfo(d)).toBeNull();
  });
});

describe("ensureServer", () => {
  const live = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ app: "sidecr", pid: process.pid, version: SERVER_API_VERSION }) });
  const livePort = Number(live.port);
  afterAll(() => live.stop(true));

  test("reuses a healthy server without spawning", async () => {
    const d = dir();
    writeInfo(d, { pid: process.pid, port: livePort, token: "t" });
    let spawned = 0;
    const info = await ensureServer(d, () => { spawned++; });
    expect(spawned).toBe(0);
    expect(info.port).toBe(livePort);
  });

  test("a stale info file triggers exactly one spawn and returns the new info", async () => {
    const d = dir();
    writeInfo(d, { pid: 999999, port: 1, token: "old" });
    let spawned = 0;
    const info = await ensureServer(d, () => {
      spawned++;
      setTimeout(() => writeInfo(d, { pid: process.pid, port: livePort, token: "new" }), 50);
    }, 3000);
    expect(spawned).toBe(1);
    expect(info.token).toBe("new");
  });

  test("gives up with a clear error when the server never appears", async () => {
    await expect(ensureServer(dir(), () => {}, 300)).rejects.toThrow(/did not start/);
  });

  test("two concurrent callers spawn exactly once and get the same info", async () => {
    const d = dir();
    let spawned = 0;
    const spawn = () => {
      spawned++;
      setTimeout(() => writeInfo(d, { pid: process.pid, port: livePort, token: "shared" }), 150);
    };
    const [a, b] = await Promise.all([ensureServer(d, spawn, 3000), ensureServer(d, spawn, 3000)]);
    expect(spawned).toBe(1);
    expect(a).toEqual(b);
    expect(a.token).toBe("shared");
    expect(existsSync(join(d, "server.lock"))).toBe(false);
  });

  test("a stale spawn lock is taken over", async () => {
    const d = dir();
    const lock = join(d, "server.lock");
    writeFileSync(lock, "999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let spawned = 0;
    const info = await ensureServer(d, () => {
      spawned++;
      writeInfo(d, { pid: process.pid, port: livePort, token: "taken-over" });
    }, 2000);
    expect(spawned).toBe(1);
    expect(info.token).toBe("taken-over");
    expect(existsSync(lock)).toBe(false);
  });

  test("a fresh spawn lock held by someone else means wait, not spawn", async () => {
    const d = dir();
    writeFileSync(join(d, "server.lock"), "other");
    let spawned = 0;
    setTimeout(() => writeInfo(d, { pid: process.pid, port: livePort, token: "theirs" }), 100);
    const info = await ensureServer(d, () => { spawned++; }, 3000);
    expect(spawned).toBe(0);
    expect(info.token).toBe("theirs");
    expect(existsSync(join(d, "server.lock"))).toBe(true); // not ours, left alone
  });

  test("the lock is released when the start fails", async () => {
    const d = dir();
    await expect(ensureServer(d, () => {}, 200)).rejects.toThrow(/did not start/);
    expect(existsSync(join(d, "server.lock"))).toBe(false);
  });

  test("a slow but alive server is not replaced: the probe is retried once", async () => {
    const d = dir();
    let hits = 0;
    const flaky = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => { if (hits++ === 0) await Bun.sleep(1200); return Response.json({ app: "sidecr", pid: process.pid, version: SERVER_API_VERSION }); },
    });
    try {
      writeInfo(d, { pid: process.pid, port: Number(flaky.port), token: "alive" });
      let spawned = 0;
      const info = await ensureServer(d, () => { spawned++; });
      expect(spawned).toBe(0);
      expect(info.token).toBe("alive");
    } finally {
      flaky.stop(true);
    }
  });

  test("another process answering 2xx on that port is not our server", async () => {
    for (const body of [() => new Response("ok"), () => Response.json({}), () => Response.json({ app: "other" })]) {
      const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: body });
      try {
        expect(await isHealthy({ pid: 1, port: Number(other.port), token: "t" })).toBe(false);
      } finally {
        other.stop(true);
      }
    }
    expect(await isHealthy({ pid: process.pid, port: livePort, token: "t" })).toBe(true);
  });

  test("a healthy sidecr server with another pid is not the one in the info file", async () => {
    expect(await isHealthy({ pid: process.pid + 1, port: livePort, token: "t" })).toBe(false);
    expect(await isHealthy({ pid: process.pid, port: livePort, token: "t" })).toBe(true);
  });

  test("isHealthy is false for a closed port", async () => {
    expect(await isHealthy({ pid: 1, port: 1, token: "t" })).toBe(false);
  });
});

describe("a server of another version is replaced", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterAll(() => { for (const x of servers) x.stop(true); });

  /** A fake sidecr server; its health answer carries `version` (or none). */
  function fake(version: number | undefined) {
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ app: "sidecr", pid: process.pid, ...(version === undefined ? {} : { version }) }),
    });
    servers.push(srv);
    return srv;
  }

  /** Injected effects: a kill that records the pid (and optionally stops the fake), a fake clock that sleep advances. */
  function deps(onKill: () => void = () => {}) {
    const kills: number[] = [];
    let clock = 0;
    const sleeps: number[] = [];
    return {
      kills,
      sleeps,
      elapsed: () => clock,
      d: {
        kill: (pid: number) => { kills.push(pid); onKill(); },
        now: () => clock,
        sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      },
    };
  }

  /** The spawn: the new server (the current version) appears and writes the info file. */
  function spawner(d: string) {
    const current = fake(SERVER_API_VERSION);
    let spawned = 0;
    return {
      spawn: () => { spawned++; writeInfo(d, { pid: process.pid, port: Number(current.port), token: "new" }); },
      count: () => spawned,
    };
  }

  test("healthOf parses the health answer, and is null when there is none", async () => {
    const s = fake(SERVER_API_VERSION);
    expect(await healthOf({ pid: 1, port: Number(s.port), token: "t" })).toEqual({ app: "sidecr", pid: process.pid, version: SERVER_API_VERSION });
    expect(await healthOf({ pid: 1, port: 1, token: "t" })).toBeNull();
    const html = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>") });
    servers.push(html);
    expect(await healthOf({ pid: 1, port: Number(html.port), token: "t" })).toBeNull();
  });

  test("a server still answering with the pre-rename app marker is not ours: never killed, never reused", async () => {
    const d = dir();
    const legacy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ app: "herdr-pal", pid: process.pid, version: SERVER_API_VERSION - 1 }),
    });
    servers.push(legacy);
    const legacyInfo = { pid: process.pid, port: Number(legacy.port), token: "legacy" };
    expect(await isHealthy(legacyInfo)).toBe(false);
    writeInfo(d, legacyInfo);
    const e = deps();
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([]);
    expect(sp.count()).toBe(1);
    expect(info.token).toBe("new");
  });

  test("an older server is asked to stop once, then exactly one new server is spawned", async () => {
    const d = dir();
    const old = fake(SERVER_API_VERSION - 1);
    writeInfo(d, { pid: process.pid, port: Number(old.port), token: "old" });
    const e = deps(() => old.stop(true)); // the kill ends the fake, as it would the real process
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([process.pid]);
    expect(sp.count()).toBe(1);
    expect(info.token).toBe("new");
    expect(readInfo(d)?.token).toBe("new");
  });

  test("a server of the current version is reused: no kill, no spawn", async () => {
    const d = dir();
    const cur = fake(SERVER_API_VERSION);
    writeInfo(d, { pid: process.pid, port: Number(cur.port), token: "cur" });
    const e = deps();
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([]);
    expect(sp.count()).toBe(0);
    expect(info.token).toBe("cur");
  });

  test("a health answer without a version counts as stale", async () => {
    const d = dir();
    const noVersion = fake(undefined);
    writeInfo(d, { pid: process.pid, port: Number(noVersion.port), token: "legacy" });
    const e = deps(() => noVersion.stop(true));
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([process.pid]);
    expect(sp.count()).toBe(1);
    expect(info.token).toBe("new");
  });

  test("a kill that throws (the process is already gone) does not break the start", async () => {
    const d = dir();
    const old = fake(SERVER_API_VERSION - 1);
    writeInfo(d, { pid: process.pid, port: Number(old.port), token: "old" });
    const e = deps();
    e.d.kill = (pid: number) => { e.kills.push(pid); old.stop(true); throw new Error("ESRCH"); };
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([process.pid]);
    expect(sp.count()).toBe(1);
    expect(info.token).toBe("new");
  });

  test("an old server that does not die within 3 s of the clock is given up on, and the start goes on", async () => {
    const d = dir();
    const stubborn = fake(SERVER_API_VERSION - 1);
    writeInfo(d, { pid: process.pid, port: Number(stubborn.port), token: "old" });
    const e = deps(); // the kill does nothing
    const sp = spawner(d);
    const info = await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([process.pid]);
    expect(e.elapsed()).toBeGreaterThanOrEqual(3000);
    expect(e.elapsed()).toBeLessThan(3500);
    expect(sp.count()).toBe(1);
    expect(info.token).toBe("new");
  });

  test("the wait ends as soon as the old server stops answering", async () => {
    const d = dir();
    const old = fake(SERVER_API_VERSION - 1);
    writeInfo(d, { pid: process.pid, port: Number(old.port), token: "old" });
    let sleepsSeen = 0;
    const e = deps();
    e.d.sleep = async (ms: number) => { sleepsSeen++; e.sleeps.push(ms); if (sleepsSeen === 2) old.stop(true); };
    const sp = spawner(d);
    await ensureServer(d, sp.spawn, 3000, e.d);
    expect(sleepsSeen).toBe(2);
  });

  test("a fresh info file written by a concurrent opener while the old server was stopping survives", async () => {
    const d = dir();
    const old = fake(SERVER_API_VERSION - 1);
    writeInfo(d, { pid: process.pid, port: Number(old.port), token: "old" });
    const current = fake(SERVER_API_VERSION);
    const fresh = { pid: process.pid, port: Number(current.port), token: "fresh" };
    // Between the kill and the removal another opener has already spawned a server and written its info.
    const e = deps(() => { old.stop(true); writeInfo(d, fresh); });
    let spawned = 0;
    const info = await ensureServer(d, () => { spawned++; }, 3000, e.d);
    expect(e.kills).toEqual([process.pid]);
    expect(spawned).toBe(0); // the fresh server was found healthy: nothing else is started
    expect(info).toEqual(fresh);
    expect(readInfo(d)).toEqual(fresh);
  });

  test("a stale-looking info file whose server is not ours (another pid) is never killed", async () => {
    const d = dir();
    const other = fake(SERVER_API_VERSION - 1); // answers with this process's pid, but the info file names another
    writeInfo(d, { pid: process.pid + 1, port: Number(other.port), token: "old" });
    const e = deps();
    const sp = spawner(d);
    await ensureServer(d, sp.spawn, 3000, e.d);
    expect(e.kills).toEqual([]);
    expect(sp.count()).toBe(1);
  });
});
