import { join } from "node:path";
import { attachmentsDirOf, pruneOld } from "./attachments";
import { Herdr } from "./herdr";
import { readMachineName } from "./machine";
import { openDirectory, openExternal, revealFile } from "./os";
import { preferredPortFrom, startOnPreferredPort } from "./port";
import { createServer } from "./server";
import { removeInfoIfOwner, stateDir, writeInfo } from "./state";
import pkg from "../package.json";

const root = join(import.meta.dir, "..");
const dir = stateDir();
const attachmentsDir = attachmentsDirOf(dir);
const IDLE_LIMIT_MS = 10 * 60 * 1000;

pruneOld(attachmentsDir, 7 * 24 * 3600 * 1000);

const token = crypto.randomUUID();
const herdr = new Herdr();
const machineName = readMachineName(dir);
// A fixed port keeps the browser's per-origin storage and notification permission across restarts.
const { server, stats, stop } = startOnPreferredPort(
  (port) =>
    createServer({
      herdr,
      token,
      attachmentsDir,
      uiDir: join(root, "ui"),
      distDir: join(root, "dist"),
      opener: (target, kind) => (kind === "dir" ? openDirectory(target) : kind === "reveal" ? revealFile(target) : openExternal(target)),
      stateDir: dir,
      machineName,
      port,
      version: pkg.version,
    }),
  preferredPortFrom(process.env.SIDECR_PORT),
);

writeInfo(dir, { pid: process.pid, port: Number(server.port), token });

function shutdown() {
  removeInfoIfOwner(dir, process.pid);
  stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {
  if (stats.sse === 0 && Date.now() - stats.lastRequest > IDLE_LIMIT_MS) shutdown();
}, 30_000);
