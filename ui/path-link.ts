import type { Token } from "../src/tokenize";

/** What a path or URL token becomes in the page: the data the click handler in app.ts reads, and how the link looks. */
export interface LinkSpec {
  /** Sent to /api/open as `kind`: "url", "dir" (a folder candidate) or "path" (a file). */
  kind: "url" | "dir" | "path";
  /** Tooltip, when the link has one. */
  title?: string;
  /** A small folder icon in front of the text. */
  folder: boolean;
  /** In the tab order and reachable with Enter or Space: the folder links (the others open with the mouse, as before). */
  focusable: boolean;
}

export const OPEN_FOLDER_TITLE = "Open folder";

export function linkSpec(t: Pick<Token, "type" | "dir">): LinkSpec {
  if (t.type === "path" && t.dir) return { kind: "dir", title: OPEN_FOLDER_TITLE, folder: true, focusable: true };
  return { kind: t.type === "url" ? "url" : "path", folder: false, focusable: false };
}

/** What a failed /api/open carries (see `api` in app.ts). */
export interface OpenFailure {
  code?: string;
  status?: number;
  message?: string;
}

/** The notice for a folder that did not open. The window cannot know the folder exists, so these are normal outcomes. */
export function folderFailureNotice(e: OpenFailure): string {
  switch (e.code) {
    case "not-found":
      return "That folder no longer exists";
    case "not-a-directory":
      return "That path is not a folder";
    case "forbidden":
      return "That folder is not one this conversation mentions";
    case "bad-path":
      return "That path cannot be opened as a folder";
    default:
      return e.message || "The folder did not open";
  }
}

/** Whether a key press on a focused link opens it (Enter or Space, no modifier other than Shift). */
export function activatesLink(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  return (e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** Shown after a file of a type that is not opened from a click has been shown in its folder instead. */
export const REVEAL_NOTICE = "This type of file is not opened from here, so it is shown in its folder";

/** After a click on a file link failed: true when the refusal was the type, so the file is shown in its folder instead. */
export function revealInstead(kind: string | undefined, e: OpenFailure): boolean {
  return kind === "path" && e.code === "type-not-openable";
}

/** Shift+click on a file link shows it in its folder, whatever its type (a secondary way, no extra control on the page). */
export function wantsReveal(kind: string | undefined, e: { shiftKey?: boolean }): boolean {
  return kind === "path" && e.shiftKey === true;
}

/** The notice for a file that did not open or reveal. */
export function fileFailureNotice(e: OpenFailure): string {
  switch (e.code) {
    case "not-found":
      return "That file no longer exists";
    case "forbidden":
      return "That file is not one this conversation mentions";
    default:
      return e.message || "The file did not open";
  }
}

/** Shown when a link that looked like a folder was a regular file (`/etc/hosts`, `Makefile`): it is shown in its folder instead. */
export const FILE_REVEALED_NOTICE = "That is a file, not a folder, so it is shown in its folder";

/** The notice for a successful /api/open answer, or null when there is nothing to say (the usual case). */
export function openedNotice(res: unknown): string | null {
  return typeof res === "object" && res !== null && (res as { revealed?: unknown }).revealed === true ? FILE_REVEALED_NOTICE : null;
}
