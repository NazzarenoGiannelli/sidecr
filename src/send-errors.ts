/*
 * Send errors the window turns into a notice of its own. No Node imports: the window's bundle uses this file too.
 */

/** The attachments folder's path has whitespace: Claude Code reads an `@path` mention only up to the first space. */
export const ATTACHMENTS_PATH_SPACES = "attachments-path-spaces";
export const ATTACHMENTS_PATH_SPACES_MESSAGE = "Attachments need a folder path without spaces. Set SIDECR_ATTACHMENTS_DIR to one.";

/** The notice for a failed send: the window's own text for the codes it knows, else the server's message or code. */
export function sendErrorText(code: string | undefined, message: string | undefined): string {
  if (code === ATTACHMENTS_PATH_SPACES) return ATTACHMENTS_PATH_SPACES_MESSAGE;
  return message || code || "Sending failed.";
}
