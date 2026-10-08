/** The port the window's server prefers. A stable origin keeps the browser's storage and notification permission. */
export const DEFAULT_PORT = 47631;

const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1024 && n <= 65535;

/** `SIDECR_PORT` when it is a valid port (1024 to 65535), else the default. */
export function preferredPortFrom(raw: string | undefined, fallback: number = DEFAULT_PORT): number {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return validPort(n) ? n : fallback;
}

/**
 * Start on the preferred port; if it cannot be taken (in use, refused) start on a free one.
 * An invalid preferred value goes straight to a free port. An error from that last attempt is thrown.
 */
export function startOnPreferredPort<T>(start: (port: number) => T, preferred: number): T {
  if (validPort(preferred)) {
    try {
      return start(preferred);
    } catch {
      /* taken by another process: fall through to a free port */
    }
  }
  return start(0);
}
