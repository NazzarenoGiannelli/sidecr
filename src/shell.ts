import { existsSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_WATCH_MS, exitWithin, launchAppWindow, type LaunchEnv, type Spawn } from "./browser";
import { effectOf, strengthToTint, type ShellEffect } from "./look";
import type { Settings } from "./settings-schema";
import type { Bounds } from "./window-bounds";

export interface ShellLookup {
  /** The plugin directory (the repo root). */
  root: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  platform: string;
}

/**
 * The native shell binary (shell/, Tauri), or null. `SIDECR_SHELL` names it explicitly; a path there that does not
 * exist gives null rather than another binary, so a typo falls back to Chromium instead of running something else.
 * Without the variable, the release build in the plugin directory is used when it has been built.
 */
export function findShell(l: ShellLookup): string | null {
  const override = l.env.SIDECR_SHELL?.trim();
  if (override) return l.exists(override) ? override : null;
  const exe = l.platform === "win32" ? "sidecr-shell.exe" : "sidecr-shell";
  const built = join(l.root, "shell", "src-tauri", "target", "release", exe);
  return l.exists(built) ? built : null;
}

export function systemShell(root: string): string | null {
  return findShell({ root, env: process.env, exists: existsSync, platform: process.platform });
}

/** What the saved settings ask of the shell at start, so the window opens with them instead of flashing the defaults. */
export interface ShellStart {
  topmost: boolean;
  effect: ShellEffect;
  /** The alpha (0-255) of the effect's tint colour. */
  tint: number;
}

/** The shell's start options from the settings. `win11` decides whether Mica and Blur fall back to Acrylic. */
export function shellStartOf(s: Settings, win11: boolean | null): ShellStart {
  return { topmost: s.alwaysOnTop, effect: effectOf(s, win11), tint: strengthToTint(s.strength) };
}

/** Windows 11 from `os.release()` on win32 (build 22000 and up); null elsewhere or when it cannot be read. */
export function isWindows11Release(platform: string, release: string): boolean | null {
  if (platform !== "win32") return null;
  const build = Number(release.split(".")[2]);
  return Number.isFinite(build) ? build >= 22000 : null;
}

/**
 * The shell's command line: the page URL, the saved bounds (CSS pixels, as the page reported them), and the start
 * options from the settings (`--no-topmost`, `--effect`, `--tint`). A shell built before those flags ignores the
 * ones it does not know, and the page applies the settings itself once it has loaded.
 */
export function shellArgs(url: string, bounds?: Bounds | null, start?: ShellStart | null): string[] {
  const args = ["--url", url];
  if (bounds) args.push("--x", String(bounds.x), "--y", String(bounds.y), "--w", String(bounds.w), "--h", String(bounds.h));
  if (start) {
    if (!start.topmost) args.push("--no-topmost");
    args.push("--effect", start.effect, "--tint", String(start.tint));
  }
  return args;
}

/** `SIDECR_LAUNCHER=chromium` forces the browser window even when the shell is built. */
export function forcedChromium(env: Record<string, string | undefined>): boolean {
  return env.SIDECR_LAUNCHER?.trim().toLowerCase() === "chromium";
}

/** Which window to try first: forced Chromium, else the shell when one is found, else Chromium. */
export function chooseLauncher(env: Record<string, string | undefined>, shell: string | null): "shell" | "chromium" {
  if (forcedChromium(env)) return "chromium";
  return shell ? "shell" : "chromium";
}

export const NO_BROWSER = "no Chromium-family browser found. Looked for Edge, then Chrome, then Chromium.";

/**
 * The precheck open.ts runs before it starts the server: the error message when there is nothing to launch, else
 * null. A built shell is enough on its own; without one (or with SIDECR_LAUNCHER=chromium) a browser is needed.
 */
export function missingLauncher(env: Record<string, string | undefined>, shell: string | null, browser: string | null): string | null {
  return !browser && chooseLauncher(env, shell) === "chromium" ? NO_BROWSER : null;
}

/** How long after starting the shell a non-zero exit still counts as "it did not start" (and Chromium opens). */
export const SHELL_WATCH_MS = 1500;

/** A spawn whose child may report its exit (Bun's Subprocess does). */
export type WatchedSpawn = Spawn;

export interface OpenWindowDeps {
  env: Record<string, string | undefined>;
  shell: string | null;
  browser: string | null;
  url: string;
  /** The state directory: the Chromium profile lives under it. */
  dir: string;
  bounds: Bounds | null;
  /** The shell's start options from the settings (not used by Chromium). */
  start?: ShellStart | null;
  spawn?: WatchedSpawn;
  /** Launches the Chromium app window; defaults to launchAppWindow. */
  launchBrowser?: (browser: string, url: string, dir: string, bounds: Bounds | null) => void | Promise<void>;
  /** How long a started window (shell or browser) is watched for an early exit. */
  watchMs?: number;
  /**
   * The environment to start the window with, only when it differs from the process's own (Linux, graphical variables
   * recovered by graphical-env.ts); Bun does not pass on changes made to process.env. Unset: the spawn default, as before.
   */
  spawnEnv?: LaunchEnv;
}

/**
 * Opens the window and says which one. The shell is spawned like the browser: detached, no stdio, unref'd, and
 * WITHOUT windowsHide (SW_HIDE would hide a GUI program's first window). Chromium is the fallback when the shell's
 * spawn throws, or when the shell exits with a non-zero code within `watchMs` (an old binary that refuses its
 * arguments, a missing WebView2 runtime). Exit code 0 is the hand-off to an already running shell. A shell that is
 * still up after `watchMs` is left alone (the watch only delays this process's own exit). Rejects only when there
 * is nothing to launch, or when the browser (the Chromium window, also the fallback) exits early with an error: an
 * OpenError with code 6 (see launchAppWindow).
 */
export async function openWindow(d: OpenWindowDeps): Promise<"shell" | "chromium"> {
  const spawn = d.spawn ?? (Bun.spawn as unknown as WatchedSpawn);
  if (chooseLauncher(d.env, d.shell) === "shell" && d.shell) {
    let child: ReturnType<Spawn> | null = null;
    try {
      child = spawn([d.shell, ...shellArgs(d.url, d.bounds, d.start)], { stdio: ["ignore", "ignore", "ignore"], detached: true, ...(d.spawnEnv ? { env: d.spawnEnv } : {}) });
      child.unref();
    } catch {
      child = null; // the binary is there but does not start: fall back to the browser
    }
    if (child) {
      const code = await exitWithin(child.exited, d.watchMs ?? SHELL_WATCH_MS);
      if (code === "running" || code === 0) return "shell";
      // it died at once: fall back to the browser
    }
  }
  if (!d.browser) throw new Error(NO_BROWSER);
  const watchMs = d.watchMs ?? BROWSER_WATCH_MS;
  await (d.launchBrowser ?? ((b, u, dir, bounds) => launchAppWindow(b, u, dir, bounds, spawn, watchMs, d.spawnEnv)))(d.browser, d.url, d.dir, d.bounds);
  return "chromium";
}
