import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { buildWindowUrl, systemBrowser } from "./browser";
import { graphicalEnvOfProcess, requireGraphicalSession } from "./graphical-env";
import { askToggle, exitCodeOf, launchDecision, launchOrExit3, OpenError } from "./launch";
import { resolvePaneId } from "./pane-id";
import { readSettings } from "./settings";
import { isWindows11Release, missingLauncher, openWindow, shellStartOf, systemShell } from "./shell";
import { ensureServer, serverSpawnOptions, stateDir } from "./state";
import { readBounds } from "./window-bounds";

/*
 * Exit codes: 0 opened (or toggled closed), 1 anything unexpected, 2 no pane in focus, 3 nothing to launch (no shell, no
 * browser), 4 the UI is not built, 5 no graphical session (Linux: no WAYLAND_DISPLAY or DISPLAY, even after asking
 * systemctl --user show-environment), 6 the browser exited early with a non-zero code (its stderr tail is in the message).
 */
async function main(): Promise<void> {
  const paneId = resolvePaneId(process.env);
  if (!paneId) {
    throw new OpenError(
      "no pane in focus (neither HERDR_PANE_ID nor focused_pane_id in HERDR_PLUGIN_CONTEXT_JSON is set). Run it from a herdr pane or key binding.",
      2,
    );
  }

  // Linux only (a no-op elsewhere): a server started over SSH has no graphical session in its environment; the variables
  // are recovered from the systemd user manager. The children are given the result explicitly, since Bun does not pass on
  // changes made to process.env. The "no session" error comes later, only when a window has to be launched.
  const graphical = graphicalEnvOfProcess();

  const root = join(import.meta.dir, "..");
  // The native shell (shell/, optional) when it is built, else the Chromium app window; Chromium is also the fallback.
  const shell = systemShell(root);
  const browser = systemBrowser();
  const missing = missingLauncher(process.env, shell, browser);
  if (missing) throw new OpenError(missing, 3);

  if (!existsSync(join(root, "dist", "app.js"))) {
    throw new OpenError('the UI is not built; run "bun run build:ui" in the plugin directory', 4);
  }

  const dir = stateDir();
  const info = await ensureServer(dir, () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = openSync(join(dir, "server.log"), "a");
    try {
      Bun.spawn([process.execPath, join(root, "src", "server-main.ts")], serverSpawnOptions(log, graphical.env)).unref();
    } finally {
      closeSync(log);
    }
  });

  // The open key is a toggle: a window already open (or still starting) is closed by the server, and nothing is launched.
  // No answer (an older server, a timeout) falls back to launching, as before.
  if (launchDecision(await askToggle(info, paneId)) === "skip") return;

  // No graphical session on Linux (nothing recovered either): exit 5.
  requireGraphicalSession(graphical);

  // The shell did not start and there is no browser: exit 3. The browser exited early with an error: exit 6.
  // The shell starts with the saved look and topmost flag (settings.json); the page applies the rest once loaded.
  const start = shellStartOf(readSettings(dir), isWindows11Release(process.platform, release()));
  await launchOrExit3(() => openWindow({ env: process.env, shell, browser, url: buildWindowUrl(info, paneId), dir, bounds: readBounds(dir), start, spawnEnv: graphical.changed ? graphical.env : undefined }));
}

try {
  await main();
} catch (e) {
  console.error(`sidecr: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(exitCodeOf(e));
}
