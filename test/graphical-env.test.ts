import { describe, expect, test } from "bun:test";
import {
  GRAPHICAL_KEYS,
  NO_GRAPHICAL_SESSION,
  NO_GRAPHICAL_SESSION_CODE,
  parseShowEnvironment,
  recoverGraphicalEnv,
  requireGraphicalSession,
  runForOutput,
  type GraphicalDeps,
} from "../src/graphical-env";
import { exitCodeOf, OpenError } from "../src/launch";

const SHOW = [
  "WAYLAND_DISPLAY=wayland-1",
  "DISPLAY=:0",
  "HYPRLAND_INSTANCE_SIGNATURE=abc123_1759500000_42",
  "XDG_CURRENT_DESKTOP=Hyprland",
  "XDG_SESSION_TYPE=wayland",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "PATH=/usr/bin:/bin",
  "HOME=/home/alice",
].join("\n");

describe("parseShowEnvironment", () => {
  test("takes the allow-listed keys and ignores everything else", () => {
    expect(parseShowEnvironment(SHOW)).toEqual({
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
      HYPRLAND_INSTANCE_SIGNATURE: "abc123_1759500000_42",
      XDG_CURRENT_DESKTOP: "Hyprland",
      XDG_SESSION_TYPE: "wayland",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });
  test("quoted values lose their quotes: '...', \"...\" and $'...' with escapes", () => {
    expect(parseShowEnvironment(`DISPLAY=':1'\nWAYLAND_DISPLAY="wayland-2"\nXDG_CURRENT_DESKTOP=$'Hypr\\'land'`)).toEqual({
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-2",
      XDG_CURRENT_DESKTOP: "Hypr'land",
    });
  });
  test("empty lines, lines without = or with an empty key, and CRLF are survived", () => {
    expect(parseShowEnvironment(`\n\nnonsense\n=x\r\nDISPLAY=:0\r\n\n`)).toEqual({ DISPLAY: ":0" });
  });
  test("a = inside the value stays in the value", () => {
    expect(parseShowEnvironment("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus,guid=a=b")).toEqual({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=a=b",
    });
  });
  test("an empty value is dropped (it would count as set); a key must match exactly", () => {
    expect(parseShowEnvironment("DISPLAY=\nXDG_SESSION_TYPE=''\nMY_DISPLAY=:9\nDISPLAYX=:8")).toEqual({});
  });
  test("the allow-list is exactly the six session variables", () => {
    expect([...GRAPHICAL_KEYS].sort()).toEqual(
      ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"],
    );
  });
});

describe("recoverGraphicalEnv", () => {
  function deps(over: Partial<GraphicalDeps> & { out?: string | null } = {}) {
    const calls: { cmd: string[]; env: Record<string, string | undefined>; timeoutMs: number }[] = [];
    const d: GraphicalDeps = {
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/home/alice" },
      exec: (cmd, env, timeoutMs) => {
        calls.push({ cmd, env, timeoutMs });
        return over.out === undefined ? SHOW : over.out;
      },
      exists: (p) => p === "/run/user/1000",
      uid: 1000,
      ...over,
    };
    return { d, calls };
  }

  test("an SSH-started server: the session variables come back and XDG_RUNTIME_DIR is /run/user/<uid>", () => {
    const { d, calls } = deps();
    const r = recoverGraphicalEnv(d);
    expect(r.session).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/alice",
      XDG_RUNTIME_DIR: "/run/user/1000",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
      HYPRLAND_INSTANCE_SIGNATURE: "abc123_1759500000_42",
      XDG_CURRENT_DESKTOP: "Hyprland",
      XDG_SESSION_TYPE: "wayland",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    // the input is not touched (open.ts hands the copy to the children)
    expect(d.env).toEqual({ PATH: "/usr/bin", HOME: "/home/alice" });
  });
  test("systemctl is run with argv (no shell), a 2 s timeout, and XDG_RUNTIME_DIR already set for it", () => {
    const { d, calls } = deps();
    recoverGraphicalEnv(d);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["systemctl", "--user", "show-environment"]);
    expect(calls[0]!.timeoutMs).toBe(2000);
    expect(calls[0]!.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  });
  test("a variable that is already set is never overwritten", () => {
    const { d } = deps({ env: { XDG_RUNTIME_DIR: "/custom/run", XDG_SESSION_TYPE: "tty", DBUS_SESSION_BUS_ADDRESS: "unix:path=/mine" } });
    const r = recoverGraphicalEnv(d);
    expect(r.env.XDG_RUNTIME_DIR).toBe("/custom/run");
    expect(r.env.XDG_SESSION_TYPE).toBe("tty");
    expect(r.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/mine");
    expect(r.env.WAYLAND_DISPLAY).toBe("wayland-1");
  });
  test("an empty variable counts as missing", () => {
    const { d } = deps({ env: { WAYLAND_DISPLAY: "", DISPLAY: "" } });
    const r = recoverGraphicalEnv(d);
    expect(r.env.WAYLAND_DISPLAY).toBe("wayland-1");
    expect(r.session).toBe(true);
  });
  test("with WAYLAND_DISPLAY or DISPLAY already there nothing is asked and nothing changes", () => {
    for (const env of [{ WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":0" }]) {
      const { d, calls } = deps({ env });
      const r = recoverGraphicalEnv(d);
      expect(calls).toHaveLength(0);
      expect(r).toEqual({ env, changed: false, session: true });
      expect(r.env).toBe(d.env);
    }
  });
  test("XDG_RUNTIME_DIR is not invented when /run/user/<uid> does not exist or there is no uid", () => {
    expect(recoverGraphicalEnv(deps({ exists: () => false }).d).env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(recoverGraphicalEnv(deps({ uid: null }).d).env.XDG_RUNTIME_DIR).toBeUndefined();
  });
  test("a failing systemctl (null, or a throw) is not fatal: no session, nothing but XDG_RUNTIME_DIR added", () => {
    for (const exec of [() => null, () => { throw new Error("ENOENT"); }] as GraphicalDeps["exec"][]) {
      const r = recoverGraphicalEnv(deps({ exec }).d);
      expect(r.session).toBe(false);
      expect(r.env).toEqual({ PATH: "/usr/bin", HOME: "/home/alice", XDG_RUNTIME_DIR: "/run/user/1000" });
    }
  });
  test("systemctl answering without any display leaves no session, and the error is the documented one with code 5", () => {
    const { d } = deps({ out: "PATH=/usr/bin\nXDG_SESSION_TYPE=tty\n" });
    const r = recoverGraphicalEnv(d);
    expect(r.session).toBe(false);
    let caught: unknown = null;
    try {
      requireGraphicalSession(r);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OpenError);
    expect((caught as OpenError).message).toBe(
      "no graphical session (no WAYLAND_DISPLAY or DISPLAY, and systemctl --user show-environment did not provide one)",
    );
    expect(NO_GRAPHICAL_SESSION).toBe((caught as OpenError).message);
    expect(exitCodeOf(caught)).toBe(5);
    expect(NO_GRAPHICAL_SESSION_CODE).toBe(5);
  });
  test("nothing to add and no session: the input env comes back as it was", () => {
    const { d } = deps({ exists: () => false, out: null });
    const r = recoverGraphicalEnv(d);
    expect(r.changed).toBe(false);
    expect(r.env).toBe(d.env);
    expect(r.session).toBe(false);
  });
  test("requireGraphicalSession accepts a result with a session", () => {
    requireGraphicalSession({ env: {}, changed: false, session: true });
  });

  test("Windows and macOS: a no-op, nothing run, no session check (even with no display variables)", () => {
    for (const platform of ["win32", "darwin"]) {
      const { d, calls } = deps({ platform });
      const r = recoverGraphicalEnv(d);
      expect(calls).toHaveLength(0);
      expect(r.changed).toBe(false);
      expect(r.session).toBe(true);
      expect(r.env).toBe(d.env);
      requireGraphicalSession(r);
    }
  });
});

describe("runForOutput (the real exec)", () => {
  test("stdout of a command that succeeds; null for a non-zero exit, a missing binary and a timeout", () => {
    expect(runForOutput([process.execPath, "-e", "console.log('A=1')"], {}, 5000)?.trim()).toBe("A=1");
    expect(runForOutput([process.execPath, "-e", "process.exit(3)"], {}, 5000)).toBeNull();
    expect(runForOutput(["definitely-not-a-binary-sidecr"], {}, 5000)).toBeNull();
    const t = Date.now();
    expect(runForOutput([process.execPath, "-e", "setTimeout(() => {}, 10000)"], {}, 300)).toBeNull();
    expect(Date.now() - t).toBeLessThan(5000);
  });
  test("the command gets the env it is given", () => {
    const out = runForOutput([process.execPath, "-e", "console.log(process.env.SIDECR_X)"], { ...process.env, SIDECR_X: "seen" }, 5000);
    expect(out?.trim()).toBe("seen");
  });
});

describe("open.ts", () => {
  test("recovers the environment before the server starts, hands it to the server and the window, and checks the session before launching", async () => {
    const src = (await Bun.file(new URL("../src/open.ts", import.meta.url)).text()).replace(/\r\n/g, "\n");
    expect(src).toContain("graphicalEnvOfProcess()");
    expect(src).toContain("serverSpawnOptions(log, graphical.env)");
    expect(src).toContain("requireGraphicalSession(graphical)");
    expect(src).toContain("spawnEnv: graphical.changed ? graphical.env : undefined");
    expect(src.indexOf("graphicalEnvOfProcess()")).toBeLessThan(src.indexOf("ensureServer("));
    expect(src.indexOf("requireGraphicalSession(graphical)")).toBeGreaterThan(src.indexOf("askToggle("));
    expect(src.indexOf("requireGraphicalSession(graphical)")).toBeLessThan(src.indexOf("launchOrExit3("));
  });
});
