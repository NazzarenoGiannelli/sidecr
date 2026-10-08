import { BLOCKED_STATUSES, DELIVERY_MODE, ENTER_KEY, MENU_SCAN_LINES, isMenuFooter, NEWLINE_KEY, type DeliveryMode } from "./config";

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions {
  /** The environment of the child process; without it the child inherits this process's. */
  env?: Record<string, string | undefined>;
  /**
   * Give up after this many ms: the child and its children are killed and the result is a failure (code -1). Only
   * the focus poll uses it; sends and screen reads keep no limit (a long paste must not be cut off).
   */
  timeoutMs?: number;
}
export type Exec = (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Kills a child and everything it started (taskkill /T on Windows, where killing the child alone leaves its own). */
type SpawnSyncLike = (cmd: string[], opts: { stdout: "ignore"; stderr: "ignore"; windowsHide: boolean; timeout: number }) => unknown;

/** taskkill by its full path: a PATH (or a working directory) holding another taskkill must not be what runs. */
export function taskkillPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return `${root}\\System32\\taskkill.exe`;
}

/** At most this long for taskkill: it runs synchronously, and a slow one must not freeze the server. */
export const TASKKILL_TIMEOUT_MS = 2000;

export function killTree(
  proc: { pid: number; kill(signal?: number | NodeJS.Signals): void },
  platform: string = process.platform,
  spawnSync: SpawnSyncLike = Bun.spawnSync as unknown as SpawnSyncLike,
  env: Record<string, string | undefined> = process.env,
): void {
  if (platform === "win32") {
    try {
      spawnSync([taskkillPath(env), "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: TASKKILL_TIMEOUT_MS });
    } catch {
      /* taskkill missing: the plain kill below still ends the child */
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export const defaultExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true, ...(opts?.env ? { env: opts.env } : {}) });
  let timedOut = false;
  const timer =
    opts?.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          killTree(proc);
        }, opts.timeoutMs)
      : null;
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (timedOut) return { code: -1, stdout: "", stderr: `herdr did not answer in ${opts!.timeoutMs} ms` };
    return { code, stdout, stderr };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/** How long `herdr pane current` may take (the focus poll runs it every 700 ms; it normally takes about 30 ms). */
export const CURRENT_PANE_TIMEOUT_MS = 3000;

export interface PaneInfo {
  paneId: string;
  agent: string | null;
  agentStatus: string;
  sessionId: string | null;
  cwd: string;
  title: string;
  workspaceId: string;
}

/** The pane herdr has in focus right now (`herdr pane current`). */
export interface CurrentPane extends PaneInfo {
  /** A machine label, when herdr names one in the answer (a pane of a saved SSH machine). */
  machine?: string;
}

export interface HerdrLike {
  getPane(id: string): Promise<PaneInfo>;
  /** The focused pane. Optional: a client without it gives no focus events (Sidecr does not follow herdr). */
  currentPane?(): Promise<CurrentPane>;
  listAgentPanes(): Promise<PaneInfo[]>;
  listWorkspaces(): Promise<{ id: string; label: string }[]>;
  readScreen(id: string): Promise<string>;
  sendText(id: string, text: string): Promise<void>;
  sendKeys(id: string, keys: string[]): Promise<void>;
}

export class HerdrError extends Error {}
export class SidecrError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function toPane(p: any): PaneInfo {
  return {
    paneId: String(p.pane_id),
    agent: p.agent ?? null,
    agentStatus: String(p.agent_status ?? "unknown"),
    sessionId: p.agent_session?.value ?? null,
    cwd: String(p.cwd ?? ""),
    title: String(p.terminal_title_stripped ?? p.terminal_title ?? p.pane_id),
    workspaceId: String(p.workspace_id ?? ""),
  };
}

/**
 * The environment for `herdr pane current`. herdr answers that command with the pane named by HERDR_PANE_ID when the
 * variable is set (focused: false), not with the focused one; the server inherits it from the pane the plugin was
 * started in, so it is removed. Everything else (the socket path, the session) stays.
 */
export function focusEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (k !== "HERDR_PANE_ID" && v !== undefined) out[k] = v;
  return out;
}

const machineOf = (p: any): string | undefined => {
  const raw = typeof p.machine === "string" ? p.machine : typeof p.machine?.label === "string" ? p.machine.label : typeof p.machine_label === "string" ? p.machine_label : undefined;
  const t = raw?.trim();
  return t ? t : undefined;
};

export class Herdr implements HerdrLike {
  constructor(
    private exec: Exec = defaultExec,
    private bin: string = process.env.HERDR_BIN_PATH ?? "herdr",
    private env: Record<string, string | undefined> = process.env,
    private currentTimeoutMs: number = CURRENT_PANE_TIMEOUT_MS,
  ) {}

  private async call(args: string[], opts?: ExecOptions): Promise<any> {
    const run = this.exec([this.bin, ...args], opts);
    // An injected exec may ignore timeoutMs: the call still gives up (a little later, so the exec's own kill wins).
    const ms = opts?.timeoutMs;
    const res =
      ms === undefined
        ? await run
        : await new Promise<ExecResult>((resolve, reject) => {
            const t = setTimeout(() => reject(new HerdrError(`herdr did not answer in ${ms} ms`)), ms + 500);
            run.then(
              (r) => {
                clearTimeout(t);
                resolve(r);
              },
              (e) => {
                clearTimeout(t);
                reject(e);
              },
            );
          });
    if (res.code !== 0) throw new HerdrError(res.stderr.trim() || res.stdout.trim() || `herdr exited with ${res.code}`);
    try {
      return res.stdout.trim() ? JSON.parse(res.stdout) : {};
    } catch {
      throw new HerdrError("herdr returned output that is not JSON");
    }
  }

  async getPane(id: string): Promise<PaneInfo> {
    const out = await this.call(["pane", "get", id]);
    if (!out?.result?.pane) throw new HerdrError(`pane ${id} not found`);
    return toPane(out.result.pane);
  }

  /**
   * The pane herdr has in focus. Throws a HerdrError when herdr is unreachable, answers without a pane, or answers
   * with a pane it does not mark as focused (the answer is then about some other pane and must not be followed).
   */
  async currentPane(): Promise<CurrentPane> {
    const out = await this.call(["pane", "current"], { env: focusEnv(this.env), timeoutMs: this.currentTimeoutMs });
    const p = out?.result?.pane;
    if (!p || p.pane_id == null) throw new HerdrError("herdr reported no current pane");
    if (p.focused === false) throw new HerdrError(`herdr reported pane ${p.pane_id}, which is not the focused one`);
    const machine = machineOf(p);
    return { ...toPane(p), ...(machine ? { machine } : {}) };
  }

  async listAgentPanes(): Promise<PaneInfo[]> {
    const out = await this.call(["agent", "list"]);
    return (out?.result?.agents ?? []).map(toPane);
  }

  async listWorkspaces(): Promise<{ id: string; label: string }[]> {
    const out = await this.call(["workspace", "list"]);
    const rows: unknown[] = Array.isArray(out?.result?.workspaces) ? out.result.workspaces : [];
    return rows.flatMap((w: any) => {
      if (!w || w.workspace_id == null) return [];
      const id = String(w.workspace_id);
      return [{ id, label: typeof w.label === "string" && w.label.trim() ? w.label : id }];
    });
  }

  async readScreen(id: string): Promise<string> {
    const res = await this.exec([this.bin, "pane", "read", id]);
    if (res.code !== 0) throw new HerdrError(res.stderr.trim() || `could not read pane ${id}`);
    return res.stdout;
  }

  async sendText(id: string, text: string): Promise<void> {
    await this.call(["pane", "send-text", id, text]);
  }

  async sendKeys(id: string, keys: string[]): Promise<void> {
    await this.call(["pane", "send-keys", id, ...keys]);
  }
}

export function assertSendable(pane: PaneInfo, screen: string): void {
  if (pane.agent !== "claude") throw new SidecrError("not-claude", "this pane is not running Claude Code");
  const tail = screen.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-MENU_SCAN_LINES);
  if (BLOCKED_STATUSES.includes(pane.agentStatus) || tail.some(isMenuFooter)) {
    throw new SidecrError("menu-open", "a menu is open in the terminal; answer it there first");
  }
}

export async function deliver(
  h: HerdrLike,
  paneId: string,
  message: string,
  mode: DeliveryMode = DELIVERY_MODE,
): Promise<void> {
  const text = message.replace(/\r\n/g, "\n");
  if (mode === "text-enter") {
    await h.sendText(paneId, text);
  } else if (mode === "paste") {
    await h.sendText(paneId, `\x1b[200~${text}\x1b[201~`);
  } else {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await h.sendText(paneId, lines[i]);
      if (i < lines.length - 1) await h.sendKeys(paneId, [NEWLINE_KEY]);
    }
  }
  await h.sendKeys(paneId, [ENTER_KEY]);
}
