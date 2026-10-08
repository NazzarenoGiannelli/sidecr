export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 30000;
/** The first tail window the history index reads (src/transcript/history.ts); it widens only for a longer row. */
export const TAIL_BYTES = 512 * 1024;

export type DeliveryMode = "text-enter" | "per-line" | "paste";
export const DELIVERY_MODE: DeliveryMode = "text-enter";
export const ENTER_KEY = "enter";
export const ESC_KEY = "esc";
export const NEWLINE_KEY = "shift+enter";
export const BLOCKED_STATUSES: readonly string[] = ["blocked"];
export const MENU_MARKER_LINE = /esc to cancel/i;
/** A menu footer has the cancel hint plus a separator or an Enter hint; prose that mentions Esc has neither. */
export const MENU_MARKER_COMPANION = /·|enter to/i;
export function isMenuFooter(line: string): boolean {
  return MENU_MARKER_LINE.test(line) && MENU_MARKER_COMPANION.test(line);
}
export const MENU_SCAN_LINES = 20;
