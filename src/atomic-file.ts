import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file-system seams of a save; tests replace them, so no test sleeps for real. */
export interface SaveDeps {
  rename?: (from: string, to: string) => void;
  /** A blocking wait, in ms. */
  wait?: (ms: number) => void;
}

const RENAME_RETRIES = 3;
const RENAME_WAIT_MS = 20;
// On Windows a rename onto a file that another process holds open (an antivirus scan, an indexer) fails for a moment.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

function blockingWait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `text` to `dir/file` through a temp file in the same directory and a rename: a crash leaves the old file or
 * the new one, never half of one. A rename that fails with EPERM/EACCES/EBUSY is retried 3 times, 20 ms apart. On
 * failure the temp file is removed and the error rethrown. Used by drafts.json and settings.json.
 */
export function writeFileAtomic(dir: string, file: string, text: string, deps: SaveDeps = {}): void {
  const rename = deps.rename ?? renameSync;
  const wait = deps.wait ?? blockingWait;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${file}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    for (let retry = 0; ; retry++) {
      try {
        rename(tmp, join(dir, file));
        break;
      } catch (e) {
        if (retry >= RENAME_RETRIES || !RETRYABLE.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
        wait(RENAME_WAIT_MS);
      }
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    throw e;
  }
}
