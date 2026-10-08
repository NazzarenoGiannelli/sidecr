import { realpathSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { isAllowedFile, norm } from "./files";
import { expandHome, hasFormatChar, looksLikeDirectory } from "./links";

/** The longest target /api/open takes for a folder, in characters (Windows' own limit is 260 without long-path support). */
export const MAX_DIR_TARGET = 4096;

/**
 * Why a request is refused. There is no "not-a-directory" any more: a regular file that looks like a folder is shown in its
 * folder instead (see resolveDir). The window still words that old 415 answer, for a server of an earlier version.
 */
export type DirError = "bad-path" | "forbidden" | "not-found";

export const DIR_STATUS: Record<DirError, number> = { "bad-path": 400, forbidden: 403, "not-found": 404 };

const CONTROL = /[\x00-\x1f\x7f]/;
// `\\server\share`, `//server/share`, `\\?\C:\x`, `\\.\pipe\x`: two separators in a row at the start, either kind.
const NETWORK_OR_DEVICE = /^[\\/]{2}/;
const DRIVE = /^[A-Za-z]:[\\/]/;

/** True when the path starts a network share or a device namespace (checked on what the window sent, and again on where it really leads). */
export function isNetworkOrDevicePath(p: string): boolean {
  return NETWORK_OR_DEVICE.test(p);
}

/**
 * What is wrong with a real path (the answer of realpath) before it goes to the file manager, or null. The same rules as for the
 * request: no control characters, no network or device path, and on Windows (where the path is written inside double
 * quotes, src/os.ts) no double quote and no trailing dot or space, which Windows drops.
 */
export function realPathProblem(p: string, platform: NodeJS.Platform = process.platform): string | null {
  if (CONTROL.test(p)) return "that path has control characters";
  if (hasFormatChar(p)) return "that path has invisible formatting characters";
  if (isNetworkOrDevicePath(p)) return "network and device paths are not opened from here";
  if (platform === "win32") {
    if (p.includes('"')) return "that path has a double quote";
    if (/[. ]$/.test(p.replace(/[\\/]+$/, ""))) return "that path ends in a dot or a space";
  }
  return null;
}

/**
 * The absolute folder path a request names, or the reason it is refused. Purely textual, nothing is read from the disk:
 * - `~/` is expanded; the result must be absolute (a drive letter and a separator on Windows, a leading slash elsewhere);
 * - no network shares, no device or extended prefixes, no alternate data streams (a `:` past the drive letter, Windows),
 *   no NUL or other control characters, and at most 4096 characters (before and after the expansion of `~`).
 */
export function parseDirTarget(target: unknown, platform: NodeJS.Platform = process.platform): { path: string } | { error: "bad-path"; message: string } {
  const bad = (message: string) => ({ error: "bad-path" as const, message });
  if (typeof target !== "string" || target === "") return bad("no folder given");
  if (target.length > MAX_DIR_TARGET) return bad("that path is too long");
  if (CONTROL.test(target)) return bad("that path has control characters");
  const p = expandHome(target);
  if (CONTROL.test(p)) return bad("that path has control characters");
  // Bidi controls and zero-width characters make a name read as another one (a link that shows `.txt` and opens `.html`).
  if (hasFormatChar(target) || hasFormatChar(p)) return bad("that path has invisible formatting characters");
  if (p.length > MAX_DIR_TARGET) return bad("that path is too long");
  if (isNetworkOrDevicePath(target) || isNetworkOrDevicePath(p)) return bad("network and device paths are not opened from here");
  if (platform === "win32") {
    if (!DRIVE.test(p)) return bad("that path is not absolute");
    if (p.indexOf(":", 2) !== -1) return bad("that path has a stream or a stray colon");
    // Explorer is given the path inside double quotes (src/os.ts): a quote would end them. A trailing dot or space is dropped by
    // Windows, so the path would name another folder than the one that was checked.
    if (p.includes('"')) return bad("that path has a double quote");
    if (/[. ]$/.test(p.replace(/[\\/]+$/, ""))) return bad("that path ends in a dot or a space");
  } else if (!p.startsWith("/")) {
    return bad("that path is not absolute");
  }
  return { path: resolve(p) };
}

const isRoot = (p: string): boolean => resolve(p) === parse(resolve(p)).root;

/** How the allow-list covers a folder: it is itself a path of the conversation, or only the folder holding a file the conversation shows. */
export type DirAllowance = "mentioned" | "parent";

/**
 * Whether the server handed this folder out. It is allowed when it is one of the paths of the conversation (`allowed`,
 * the same set that guards files, compared in the same way: resolved, lower-cased on Windows), or the folder that
 * directly contains one of the files in it, which the window already shows. Only one level up: the parent of that
 * parent is not allowed. A filesystem or drive root is never allowed through a file; only a mention of the root itself counts.
 */
export function dirAllowance(target: string, allowed: Iterable<string>): DirAllowance | null {
  const t = norm(target);
  const rootTarget = isRoot(target);
  let viaParent = false;
  for (const a of allowed) {
    if (norm(a) === t) return "mentioned";
    if (!rootTarget && !looksLikeDirectory(a) && norm(dirname(resolve(a))) === t) viaParent = true;
  }
  return viaParent ? "parent" : null;
}

export function isAllowedDir(target: string, allowed: Iterable<string>): boolean {
  return dirAllowance(target, allowed) !== null;
}

/** A folder to open, or (`revealed`) a regular file that a folder-looking mention turned out to be: it is shown in its folder instead. */
export type ResolvedDir = { dir: string } | { file: string } | { error: DirError; message: string };

/**
 * Checks a folder target against the allow-list and the disk, in that order, and gives the real path to open.
 * The real path (symlinks and junctions followed) must not lead to a network share, and a folder that was allowed only as
 * the parent of a file must not lead to a drive or filesystem root (a junction to `D:\`). Nothing inside the folder is read:
 * only its type. A path with no extension that is a regular file (`/etc/hosts`, `Makefile`, `~/.bashrc`; the window links
 * those as folders because it cannot tell) comes back as `{ file }`, to be revealed, if the path itself was mentioned. Anything that is
 * neither a file nor a folder (a device, a socket) is not found.
 */
export function resolveDir(target: unknown, allowed: Iterable<string>, platform: NodeJS.Platform = process.platform): ResolvedDir {
  const parsed = parseDirTarget(target, platform);
  if ("error" in parsed) return parsed;
  const how = dirAllowance(parsed.path, allowed);
  if (!how) return { error: "forbidden", message: "that folder is not one the conversation mentions" };
  let real: string;
  try {
    real = realpathSync(parsed.path);
  } catch {
    return { error: "not-found", message: "that folder no longer exists" };
  }
  const problem = realPathProblem(real, platform);
  if (problem) return { error: "bad-path", message: problem };
  if (how === "parent" && isRoot(real)) return { error: "forbidden", message: "that folder is not one the conversation mentions" };
  try {
    const st = statSync(real);
    if (st.isDirectory()) return { dir: real };
    if (st.isFile() && how === "mentioned") return { file: real };
  } catch {
    /* gone between the two calls: not found */
  }
  return { error: "not-found", message: "that folder no longer exists" };
}

export type ResolvedFile = { path: string } | { error: DirError; message: string };

/**
 * Checks a file target for a plain open: the same textual rules (parseDirTarget: absolute, no control or formatting
 * characters, no network or device path, no stream, no double quote, no trailing dot or space), the same allow-list and the same
 * real-path rules as "show in folder" (resolveReveal), because the file is about to be handed to the OS. Gives the path as
 * written, normalised (its name is what the user saw, and what decided the type), not the real path.
 */
export function resolveOpen(target: unknown, allowed: Iterable<string>, attachmentsDir: string, platform: NodeJS.Platform = process.platform): ResolvedFile {
  const checked = resolveReveal(target, allowed, attachmentsDir, platform);
  if ("error" in checked) return checked;
  const parsed = parseDirTarget(target, platform);
  return "error" in parsed ? parsed : { path: parsed.path };
}

/**
 * Checks a file target for "show in folder": the same textual rules and the same allow-list as opening a file (a path of the
 * conversation, or something in the attachments directory), and it must exist, but NOT the openable-type list: showing a file
 * in its folder never runs it, so an executable can be revealed. Gives the real path.
 */
export function resolveReveal(target: unknown, allowed: Iterable<string>, attachmentsDir: string, platform: NodeJS.Platform = process.platform): ResolvedFile {
  const parsed = parseDirTarget(target, platform);
  if ("error" in parsed) return parsed;
  if (!isAllowedFile(parsed.path, allowed, attachmentsDir)) return { error: "forbidden", message: "that file is not one the conversation mentions" };
  let real: string;
  try {
    real = realpathSync(parsed.path);
  } catch {
    return { error: "not-found", message: "that file no longer exists" };
  }
  const problem = realPathProblem(real, platform);
  if (problem) return { error: "bad-path", message: problem };
  // A drive or filesystem root is a folder: there is no file to select in it.
  if (isRoot(real) || isRoot(parsed.path)) return { error: "bad-path", message: "a drive or filesystem root cannot be shown in a folder" };
  return { path: real };
}
