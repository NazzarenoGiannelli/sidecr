import { existsSync } from "node:fs";

/** The part of Bun.spawn the openers use, so tests can see the command line without starting anything. */
export interface Spawned {
  unref(): void;
}
export interface SpawnOptions {
  stdio: ["ignore", "ignore", "ignore"];
  /** Windows: the arguments are joined with spaces as they are, without Bun's own quoting. */
  windowsVerbatimArguments?: boolean;
}
export type SpawnFn = (cmd: string[], opts: SpawnOptions) => Spawned;

export interface OsDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
}

const realSpawn: SpawnFn = (cmd, opts) => Bun.spawn(cmd, opts);
const DRIVE_START = /^[A-Za-z]:\\/;

export async function openExternal(target: string, deps: OsDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const cmd =
    platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", target]
      : platform === "darwin"
        ? ["open", target]
        : ["xdg-open", target];
  // A GUI launcher, so never windowsHide: rundll32 passes its own STARTUPINFO show state on to ShellExecute, and the application
  // that opens the file (a text editor, say) would start with a hidden main window. xdg-open and open are not console programs either.
  // Bun quotes the target as it needs (a space in the path), so no verbatim arguments here.
  (deps.spawn ?? realSpawn)(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

/**
 * How a file manager is started: a GUI process, so no windowsHide (SW_HIDE would reach the program that is started). On Windows the command line is built by hand (see
 * quotedWindowsPath), so Bun must pass it on as it is.
 */
export function guiSpawnOptions(platform: NodeJS.Platform = process.platform): SpawnOptions {
  return platform === "win32"
    ? { stdio: ["ignore", "ignore", "ignore"], windowsVerbatimArguments: true }
    : { stdio: ["ignore", "ignore", "ignore"] };
}

/**
 * A Windows path as it goes into Explorer's command line: backslashes, checked, and always inside double quotes by the caller.
 * Explorer's own command line grammar treats a comma as a separator (`/select,<file>`, `,/root,<folder>`), and Bun only
 * quotes an argument that has a space, a tab or a quote, so a path with a bare comma would be cut there and the rest read
 * as another target. Hence the quotes are always written, and the path must not hold anything that could end them: a double
 * quote or a control character. A trailing dot or space is refused too: Windows drops it, so the path would name another folder.
 */
function windowsPath(p: string, what: string): { path: string; root: boolean } {
  const win = p.replaceAll("/", "\\");
  if (!DRIVE_START.test(win)) throw new Error(`a ${what} must start with a drive letter`);
  if (/["\x00-\x1f\x7f]/.test(win)) throw new Error(`a ${what} cannot have a double quote or a control character`);
  // No trailing backslash: in front of the closing quote it would read as an escaped quote (`"C:\a\"` is `C:\a"`).
  const bare = win.replace(/\\+$/, "");
  if (/[. ]$/.test(bare)) throw new Error(`a ${what} cannot end in a dot or a space`);
  const root = /^[A-Za-z]:$/.test(bare);
  return { path: root ? `${bare}\\` : bare, root };
}

/** How a Windows folder goes on the command line: in double quotes, except a drive root (`D:\`), which cannot hold a comma and whose backslash must not touch a quote. */
function quotedFolder(w: { path: string; root: boolean }): string {
  return w.root ? w.path : `"${w.path}"`;
}

/**
 * The command that shows a folder in the system's default file manager, never through a shell, never `start`, so nothing
 * inside the folder is run. Windows: `explorer.exe "<folder>"` with the path always in double quotes, written by hand and
 * passed verbatim (guiSpawnOptions); it must start with a drive letter, so no `/` or `-` can be read as a switch. macOS: `open <folder>`,
 * except for a name with an extension or a folder holding Contents/Info.plist, which may be an application bundle (`Foo.app`,
 * `Setup.pkg`) that `open` would run: it is shown with `open -R` instead (the root `/` is opened as it is). Linux: `xdg-open <folder>`, always an absolute path.
 */
export function directoryCommand(dir: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string[] {
  if (platform === "win32") return ["explorer.exe", quotedFolder(windowsPath(dir, "folder to open"))];
  if (!dir.startsWith("/")) throw new Error("a folder to open must be an absolute path");
  if (platform === "darwin") {
    const bare = dir.replace(/\/+$/, "") || "/";
    if (bare === "/") return ["open", "/"];
    // A bundle (Foo.app, Setup.pkg, x.qlgenerator, or any folder with Contents/Info.plist) is a folder that `open` would run: it is shown.
    const name = bare.slice(bare.lastIndexOf("/") + 1);
    const bundle = name.lastIndexOf(".") > 0 || exists(`${bare}/Contents/Info.plist`);
    return bundle ? ["open", "-R", bare] : ["open", dir];
  }
  return ["xdg-open", dir];
}

/**
 * Opens a folder in the default file manager (Explorer, the desktop's own on Linux, Finder). The process is not waited for:
 * explorer.exe exits with 1 even when it worked, so an exit code says nothing, and a failure to start at all (no such
 * program) is what throws.
 */
export async function openDirectory(dir: string, deps: OsDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  (deps.spawn ?? realSpawn)(directoryCommand(dir, platform), guiSpawnOptions(platform)).unref();
}

/**
 * The command that shows a file in its folder, never opening it. Windows: `explorer.exe /select,"<path>"` (one token, the
 * path always quoted, see windowsPath). macOS: `open -R`. Linux has no portable "select", so the folder that holds the
 * file is opened instead. A script or an executable is only ever pointed at, so what is revealed may be of any type.
 */
export function revealCommand(file: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const w = windowsPath(file, "file to reveal");
    if (w.root) throw new Error("a drive root cannot be revealed");
    return ["explorer.exe", `/select,"${w.path}"`];
  }
  if (!file.startsWith("/")) throw new Error("a file to reveal must be an absolute path");
  if (platform === "darwin") return ["open", "-R", file];
  const slash = file.lastIndexOf("/");
  return ["xdg-open", slash <= 0 ? "/" : file.slice(0, slash)];
}

/** Shows a file in the file manager (see revealCommand). Not waited for, like openDirectory. */
export async function revealFile(file: string, deps: OsDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  (deps.spawn ?? realSpawn)(revealCommand(file, platform), guiSpawnOptions(platform)).unref();
}
