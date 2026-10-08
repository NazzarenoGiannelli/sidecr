import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SERVER_API_VERSION } from "./version";

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
}

/** How the server (a console process, so hiding its console window is right) is started. */
export function serverSpawnOptions(logFd: number, env: Record<string, string | undefined>) {
  return { stdio: ["ignore", logFd, logFd] as ["ignore", number, number], env, detached: true, windowsHide: true };
}

export function stateDir(): string {
  return process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".config", "sidecr");
}

export function readInfo(dir: string): ServerInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    if (typeof raw.pid === "number" && typeof raw.port === "number" && typeof raw.token === "string") return raw;
  } catch {
    /* missing or corrupt */
  }
  return null;
}

export function writeInfo(dir: string, info: ServerInfo): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "server.json"), JSON.stringify(info), { mode: 0o600 });
}

export function removeInfo(dir: string): void {
  try {
    unlinkSync(join(dir, "server.json"));
  } catch {
    /* already gone */
  }
}

/** Remove the info file only if this pid wrote it, so an orphan never deletes a live server's file. */
export function removeInfoIfOwner(dir: string, pid: number): void {
  if (readInfo(dir)?.pid === pid) removeInfo(dir);
}

export interface Health {
  app: unknown;
  pid: unknown;
  version: unknown;
}

/** What the server on this port says at /health, parsed; null when there is no answer or it is not a JSON object. */
export async function healthOf(info: ServerInfo): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const body = (await res.json()) as { app?: unknown; pid?: unknown; version?: unknown } | null;
    if (typeof body !== "object" || body === null) return null;
    return { app: body.app, pid: body.pid, version: body.version };
  } catch {
    return null;
  }
}

/** Any 2xx from another process on a reused port must not count as our server; the pid too, so another Sidecr server is not the one this info file describes. The marker of the pre-rename build is deliberately not accepted, so a leftover old server is neither reused nor killed. */
const isOurs = (h: Health | null, info: ServerInfo): h is Health => h?.app === "sidecr" && h.pid === info.pid;

export async function isHealthy(info: ServerInfo): Promise<boolean> {
  return isOurs(await healthOf(info), info);
}

const LOCK_FILE = "server.lock";

/** Exclusive-create the spawn lock. A lock older than `staleMs` is stale and is taken over. */
function acquireSpawnLock(dir: string, staleMs: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs <= staleMs) return false;
        unlinkSync(path);
      } catch {
        /* the holder released it between our attempts: try again */
      }
    }
  }
  return false;
}

function releaseSpawnLock(dir: string): void {
  try {
    unlinkSync(join(dir, LOCK_FILE));
  } catch {
    /* already gone */
  }
}

/** The effects ensureServer has on the machine, injectable so tests neither kill anything nor wait. */
export interface EnsureDeps {
  kill?: (pid: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETIRE_WAIT_MS = 3000;

export async function ensureServer(dir: string, spawnServer: () => void, timeoutMs = 6000, deps: EnsureDeps = {}): Promise<ServerInfo> {
  const kill = deps.kill ?? ((pid: number) => void process.kill(pid));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const existing = readInfo(dir);
  if (existing) {
    // A slow server is not a dead one: probe a second time before replacing it.
    let health = await healthOf(existing);
    if (!isOurs(health, existing)) {
      await sleep(300);
      health = await healthOf(existing);
    }
    if (isOurs(health, existing)) {
      if (health.version === SERVER_API_VERSION) return existing;
      // An older build (or one that does not report a version) would not understand the new window, so it is replaced.
      try {
        kill(existing.pid);
      } catch {
        /* already gone */
      }
      const deadline = now() + RETIRE_WAIT_MS;
      while (now() < deadline && (await isHealthy(existing))) await sleep(100);
      // Not under the spawn lock: a concurrent opener may have spawned a server and written its info meanwhile.
      // Only the file of the server just retired is removed; a fresh one is left for the path below to find.
      const onDisk = readInfo(dir);
      if (onDisk && onDisk.pid === existing.pid && onDisk.port === existing.port && onDisk.token === existing.token) removeInfo(dir);
    }
  }
  // Only the caller that holds the lock spawns; the others wait for the info file it produces.
  const owner = acquireSpawnLock(dir, timeoutMs);
  try {
    if (owner) {
      const current = readInfo(dir);
      if (current && (await isHealthy(current))) return current;
      removeInfo(dir);
      spawnServer();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = readInfo(dir);
      if (info && (await isHealthy(info))) return info;
      await Bun.sleep(100);
    }
    throw new Error(`the Sidecr server did not start within ${timeoutMs} ms (state dir: ${dir})`);
  } finally {
    if (owner) releaseSpawnLock(dir);
  }
}
