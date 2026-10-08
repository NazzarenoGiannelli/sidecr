import { existsSync } from "node:fs";
import { OpenError } from "./launch";

/**
 * On Linux the window needs the user's graphical session. When herdr's server was started over SSH (a machine
 * respawned from another host) the environment it passes down has none of it, and Chromium exits at once with
 * "Failed to connect to Wayland display". The systemd user manager still knows the session's variables
 * (`systemctl --user show-environment`), so they are read back from there. Everything here is a no-op on
 * Windows and macOS, and the I/O is injected so the logic can be tested without a Linux box.
 */

/** The only variables copied from systemd's user environment. */
export const GRAPHICAL_KEYS: readonly string[] = [
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** The message (printed after `sidecr: `) when no graphical session can be found. Exit code NO_GRAPHICAL_SESSION_CODE. */
export const NO_GRAPHICAL_SESSION = "no graphical session (no WAYLAND_DISPLAY or DISPLAY, and systemctl --user show-environment did not provide one)";
export const NO_GRAPHICAL_SESSION_CODE = 5;

/** How long `systemctl --user show-environment` may take before it is given up on. */
export const SYSTEMCTL_TIMEOUT_MS = 2000;

type Env = Record<string, string | undefined>;

function unquote(v: string): string {
  // systemd prints values with special characters in shell form: $'a\nb', 'a b' or "a b".
  if (v.length >= 3 && v.startsWith("$'") && v.endsWith("'")) {
    return v.slice(2, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) return v.slice(1, -1);
  return v;
}

/** The allow-listed `KEY=VALUE` lines of `systemctl --user show-environment`; unknown keys and empty values are dropped. */
export function parseShowEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!GRAPHICAL_KEYS.includes(key)) continue;
    const value = unquote(line.slice(eq + 1));
    if (value !== "") out[key] = value;
  }
  return out;
}

export interface GraphicalDeps {
  platform: string;
  env: Env;
  /** Runs the command with this environment and gives its stdout, or null when it failed, timed out or is missing. */
  exec: (cmd: string[], env: Env, timeoutMs: number) => string | null;
  exists: (path: string) => boolean;
  /** process.getuid(), or null where there is none. */
  uid: number | null;
}

export interface GraphicalResult {
  /** The environment to launch with: `deps.env` itself when nothing was added, else a copy with the recovered variables. */
  env: Env;
  /** Variables were added, so the children must be given `env` explicitly (Bun does not pass on changes to process.env). */
  changed: boolean;
  /** WAYLAND_DISPLAY or DISPLAY is available (always true off Linux, where nothing is checked). */
  session: boolean;
}

const has = (env: Env, key: string): boolean => (env[key] ?? "") !== "";
const hasDisplay = (env: Env): boolean => has(env, "WAYLAND_DISPLAY") || has(env, "DISPLAY");

/**
 * Linux only, and only when both WAYLAND_DISPLAY and DISPLAY are missing: recovers the graphical variables from the
 * systemd user manager. XDG_RUNTIME_DIR (`/run/user/<uid>`, when it exists) is set first, since systemctl --user needs it
 * to find the user bus and Chromium needs it for the Wayland socket. A variable that is already set is never overwritten,
 * and a failing systemctl is not an error here (the caller checks `session`).
 */
export function recoverGraphicalEnv(d: GraphicalDeps): GraphicalResult {
  if (d.platform !== "linux" || hasDisplay(d.env)) return { env: d.env, changed: false, session: true };
  const env: Env = { ...d.env };
  let changed = false;
  if (!has(env, "XDG_RUNTIME_DIR") && d.uid !== null) {
    const dir = `/run/user/${d.uid}`;
    if (d.exists(dir)) {
      env.XDG_RUNTIME_DIR = dir;
      changed = true;
    }
  }
  let text: string | null = null;
  try {
    text = d.exec(["systemctl", "--user", "show-environment"], env, SYSTEMCTL_TIMEOUT_MS);
  } catch {
    text = null; // not recoverable: reported by the caller
  }
  if (text) {
    for (const [key, value] of Object.entries(parseShowEnvironment(text))) {
      if (has(env, key)) continue;
      env[key] = value;
      changed = true;
    }
  }
  return { env: changed ? env : d.env, changed, session: hasDisplay(env) };
}

/** Throws the "no graphical session" OpenError when the result has none. */
export function requireGraphicalSession(r: GraphicalResult): void {
  if (!r.session) throw new OpenError(NO_GRAPHICAL_SESSION, NO_GRAPHICAL_SESSION_CODE);
}

/** The real exec: argv, no shell, bounded by the timeout; any failure (missing binary, non-zero exit, timeout) is null. */
export function runForOutput(cmd: string[], env: Env, timeoutMs: number): string | null {
  try {
    const r = Bun.spawnSync(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** recoverGraphicalEnv with the real process. */
export function graphicalEnvOfProcess(): GraphicalResult {
  return recoverGraphicalEnv({
    platform: process.platform,
    env: process.env,
    exec: runForOutput,
    exists: existsSync,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  });
}
