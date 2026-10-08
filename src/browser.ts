import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenError } from "./launch";
import type { ServerInfo } from "./state";
import type { Bounds } from "./window-bounds";

export interface BrowserLookup {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  which: (name: string) => string | null;
}

export function findBrowser(l: BrowserLookup): string | null {
  if (l.platform === "win32") {
    const pf86 = l.env["ProgramFiles(x86)"];
    const pf = l.env["ProgramFiles"];
    const local = l.env["LOCALAPPDATA"];
    const candidates = [
      pf86 && `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      pf && `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      pf && `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      pf86 && `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter((c): c is string => Boolean(c));
    return candidates.find((c) => l.exists(c)) ?? null;
  }
  for (const name of ["microsoft-edge-stable", "microsoft-edge", "google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const found = l.which(name);
    if (found) return found;
  }
  return null;
}

export function systemBrowser(): string | null {
  return findBrowser({
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    which: (name) => Bun.which(name),
  });
}

// "localhost", not 127.0.0.1: Chromium stores an app window's placement under a key made from the URL host, and a
// host with dots is split into nested keys and never restored. The server still binds 127.0.0.1 only.
export function buildWindowUrl(info: ServerInfo, paneId: string): string {
  return `http://localhost:${info.port}/?t=${encodeURIComponent(info.token)}&pane=${encodeURIComponent(paneId)}`;
}

/** The Chromium profile directory name on Linux; it ends up in the Wayland app_id (`chrome-localhost__-Sidecr`). */
export const LINUX_PROFILE_DIRECTORY = "Sidecr";

/**
 * Saved bounds (kept by the app, see window-bounds.ts) set position and size. Without them the size is only forced
 * on the first launch, so Chromium can remember what the user resized the window to.
 */
export function browserArgs(
  url: string,
  profileDir: string,
  profileExists: boolean,
  bounds?: Bounds | null,
  platform: string = process.platform,
): string[] {
  // English whatever the system language is (the context menu and the browser's own chrome), and no "Translate this page?"
  // bar: the page says lang=en while a conversation is often Italian, and a fresh profile offers to translate it.
  const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--lang=en-US", "--disable-features=Translate"];
  // Linux only: on Wayland Chromium derives the app_id from the URL host and the profile directory name, so the
  // default profile gives the generic `chrome-localhost__-Default`. A named profile gives `chrome-localhost__-Sidecr`,
  // which a window rule can match (--class does not change the app_id on Wayland). Windows keeps its data in Default.
  if (platform === "linux") args.push(`--profile-directory=${LINUX_PROFILE_DIRECTORY}`);
  if (bounds) args.push(`--window-position=${bounds.x},${bounds.y}`, `--window-size=${bounds.w},${bounds.h}`);
  else if (!profileExists) args.push("--window-size=520,760");
  return args;
}


export type LaunchEnv = Record<string, string | undefined>;

/** The child of a launch: Bun's Subprocess has all of this. stderr is only there when it was asked for ("pipe"). */
export interface LaunchedChild {
  unref(): void;
  exited?: Promise<number | null>;
  stderr?: ReadableStream<Uint8Array> | null;
}

export type Spawn = (
  cmd: string[],
  opts: { stdio: ["ignore", "ignore", "ignore" | "pipe"]; detached: boolean; env?: LaunchEnv },
) => LaunchedChild;

/** How long after starting the browser a non-zero exit still counts as "it did not start" and is reported. */
export const BROWSER_WATCH_MS = 1500;

/** The child's exit code if it exits within `ms`, null when its promise rejects, else "running". */
export async function exitWithin(exited: Promise<number | null> | undefined, ms: number): Promise<number | null | "running"> {
  if (!exited) return "running";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"running">((resolve) => {
    timer = setTimeout(() => resolve("running"), ms);
  });
  try {
    return await Promise.race([exited.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The end of a stderr text for a one-line message: its last non-empty lines, joined with " | ", at most `max` characters. */
export function stderrTail(text: string, max = 300): string {
  const lines = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kept: string[] = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i]!.length + (kept.length ? 3 : 0);
    if (len + add > max) break;
    kept.unshift(lines[i]!);
    len += add;
  }
  if (kept.length === 0 && lines.length > 0) return lines[lines.length - 1]!.slice(-max);
  return kept.join(" | ");
}

/** Reads the last `cap` characters of a stream in the background; `stop` lets go of it, `text` waits a moment for the end. */
function followTail(stream: ReadableStream<Uint8Array> | null | undefined, cap = 4096): { text(): Promise<string>; stop(): void } {
  if (!stream) return { text: async () => "", stop() {} };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return { text: async () => "", stop() {} };
  }
  const decoder = new TextDecoder();
  let tail = "";
  const finished = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-cap);
      }
    } catch {
      /* the pipe broke: what was read is all there is */
    }
  })();
  const stop = () => void reader.cancel().catch(() => {});
  return {
    stop,
    async text() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, 200)))]);
      clearTimeout(timer);
      stop();
      return tail;
    },
  };
}

/**
 * Starts the Chromium app window and watches it for `watchMs`: detached and unref'd, stdout ignored, stderr piped for
 * the watch window only (it is let go of afterwards, so a browser that stays up does not keep this process alive).
 * Exit code 0 is the hand-off to an already running browser instance: silent success. A non-zero exit inside the window
 * (a Wayland/X connection that failed, a bad profile directory) rejects with an OpenError (code 6) that carries the end
 * of stderr, instead of the silent exit 0 it used to be. A browser still running after the window is left alone.
 * `env`, when given, is passed to the browser (Bun does not pass on changes made to process.env).
 */
export async function launchAppWindow(
  browser: string,
  url: string,
  userDataDir: string,
  bounds?: Bounds | null,
  spawn: Spawn = Bun.spawn as unknown as Spawn,
  watchMs: number = BROWSER_WATCH_MS,
  env?: LaunchEnv,
  platform: string = process.platform,
): Promise<void> {
  const profile = join(userDataDir, "profile");
  // No windowsHide here: it passes SW_HIDE to a GUI program, and with a fresh profile (no saved window state to
  // restore) Edge/Chrome obey it and the first window opens hidden. Only console children (the server) are hidden.
  const child = spawn([browser, ...browserArgs(url, profile, existsSync(profile), bounds, platform)], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    ...(env ? { env } : {}),
  });
  child.unref();
  const stderr = followTail(child.stderr);
  const code = await exitWithin(child.exited, watchMs);
  if (code === "running" || code === 0) {
    stderr.stop();
    return;
  }
  const tail = stderrTail(await stderr.text());
  throw new OpenError(`the browser exited early (code ${code ?? "unknown"})${tail ? `: ${tail}` : ""}`, 6);
}
