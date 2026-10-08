import type { ServerInfo } from "./state";

/** What the server said to the open key: "close" means a window is open (or starting) and is being closed, so nothing is launched. */
export function launchDecision(answer: unknown): "launch" | "skip" {
  if (typeof answer === "object" && answer !== null && (answer as { action?: unknown }).action === "close") return "skip";
  return "launch";
}

/**
 * Asks the running server whether the open key should open or close. Resolves to the parsed answer,
 * or null when there is none (timeout, refused, 401, 404 from an older server, a body that is not JSON).
 */
export async function askToggle(info: ServerInfo, pane: string, timeoutMs = 2000): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/toggle`, {
      method: "POST",
      headers: { cookie: `sidecr=${info.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pane }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * An error of the open command with the process exit code it maps to:
 * 2 no pane, 3 nothing to launch, 4 UI not built, 5 no graphical session (Linux), 6 the browser exited early with an error.
 */
export class OpenError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

/** The exit code for whatever the open command threw: an OpenError's own code, 1 for anything else. */
export function exitCodeOf(e: unknown): number {
  return e instanceof OpenError ? e.code : 1;
}

/**
 * Runs the window launch; a rejection (the shell did not start and there is no browser) becomes an OpenError with exit
 * code 3. An OpenError of its own (the browser exited early: code 6) keeps its code.
 */
export async function launchOrExit3(launch: () => Promise<unknown>): Promise<void> {
  try {
    await launch();
  } catch (e) {
    if (e instanceof OpenError) throw e;
    throw new OpenError(e instanceof Error ? e.message : String(e), 3);
  }
}
