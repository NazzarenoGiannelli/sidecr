import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { TranscriptReader } from "./history";

/** The real file system behind the history index (src/transcript/history.ts takes any reader, tests inject one). */
export const fsTranscriptReader: TranscriptReader = {
  size(file) {
    try {
      return statSync(file).size;
    } catch {
      return null;
    }
  },
  read(file, start, end) {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, end - start));
      const got = readSync(fd, buf, 0, buf.length, start);
      return got === buf.length ? buf : buf.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  },
};
