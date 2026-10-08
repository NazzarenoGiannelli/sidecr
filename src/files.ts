import { basename, dirname, extname, resolve } from "node:path";
import { isSidecrAttachmentName } from "./attachments";

export { isImagePath } from "./imagepath";

// An allow-list, not a denylist: opening a file hands it to the OS default handler, which runs scripts.
// `.html` and `.htm` are on it because the user asked for it: the default app is the browser, so a click runs the page the way a
// double click in Explorer does. Everything else that runs or installs (exe, bat, cmd, com, ps1, sh, msi, js, vbs, hta, jar,
// lnk, url, reg, scr, dll, appimage, desktop...) stays off the list and is only ever revealed in its folder.
const OPENABLE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf",
  ".md", ".txt", ".json", ".csv", ".log", ".docx", ".xlsx", ".pptx",
  ".html", ".htm",
]);

export function isOpenablePath(p: string): boolean {
  return OPENABLE_EXT.has(extname(p).toLowerCase());
}

/** The form two paths are compared in: resolved, and lower-cased on Windows (the file system ignores case there). */
export function norm(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function isAllowedFile(target: string, allowed: Iterable<string>, attachmentsDir: string): boolean {
  const t = norm(target);
  // An attachment: a file Sidecr saved (its own name pattern), directly in the attachments folder.
  if (dirname(t) === norm(attachmentsDir) && isSidecrAttachmentName(basename(t))) return true;
  for (const a of allowed) if (norm(a) === t) return true;
  return false;
}
