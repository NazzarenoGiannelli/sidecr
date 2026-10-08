/**
 * The shell's lightbox window (shell/src-tauri/src/lightbox.rs): which image URLs the page hands to the
 * `open_lightbox` command, and how the lightbox page reads them back. The Rust side validates again; these
 * checks keep the page from sending anything it would refuse. Pure: no DOM.
 */
import { isCloseChord } from "./close-chord";
import type { KeyLike } from "./keys";

/** Must match the Rust constants. */
export const MAX_IMAGES = 64;
export const MAX_SRC_LEN = 4096;
export const LIGHTBOX_CLOSED_EVENT = "sidecr:lightbox-closed";
/**
 * The lightbox page navigates to `/lightbox.html?close=sidecr` on the close chord: its capability only lets it close
 * itself, so this navigation is how it asks the shell to close Sidecr. The shell's navigation guard cancels it and
 * closes the main window (shell/src-tauri/src/lightbox.rs, CLOSE_SIDECR_QUERY).
 */
export const CLOSE_SIDECR_QUERY = ["close", "sidecr"] as const;

/** A lightbox page loaded with the close signal (the shell let it through: an older shell): it closes itself. */
export function isCloseSignal(search: string): boolean {
  return new URLSearchParams(search).get(CLOSE_SIDECR_QUERY[0]) === CLOSE_SIDECR_QUERY[1];
}
const IMAGE_PATHS = ["/api/file", "/api/image"];

/** A same-origin image endpoint path with a query: "/api/file?…" or "/api/image?…". Nothing else. */
export function isLightboxSrc(src: unknown): src is string {
  if (typeof src !== "string" || src.length === 0 || src.length > MAX_SRC_LEN) return false;
  if (!src.startsWith("/") || src.startsWith("//") || src.includes("\\") || /[\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.includes("#")) return false;
  const q = src.indexOf("?");
  if (q < 0 || q === src.length - 1) return false;
  return IMAGE_PATHS.includes(src.slice(0, q));
}

/** What the page knows about a thumbnail. */
export interface ThumbInfo {
  /** The <img> src as the browser resolved it (absolute). */
  src: string;
  /** For an image pasted into the terminal (a data: URL): its exchange and block, from data-ex / data-block. */
  ex?: string;
  block?: string;
}

/**
 * The lightbox URL of a thumbnail: an /api/file thumbnail keeps its own path and query; a data: thumbnail (an image
 * pasted into the terminal) becomes /api/image by exchange and block. Null when it is neither.
 */
export function lightboxSrcOf(t: ThumbInfo, origin: string, pane: string): string | null {
  if (t.src.startsWith("data:")) {
    if (!t.ex || !t.block || !/^[ua]\d{1,4}$/.test(t.block)) return null;
    const src = `/api/image?pane=${encodeURIComponent(pane)}&ex=${encodeURIComponent(t.ex)}&block=${t.block}`;
    return isLightboxSrc(src) ? src : null;
  }
  if (!t.src.startsWith(`${origin}/`)) return null;
  const rel = t.src.slice(origin.length);
  return isLightboxSrc(rel) ? rel : null;
}

/**
 * The command's arguments for the clicked image among all the thumbnails: the valid URLs in page order (repeats
 * kept, at most MAX_IMAGES around the clicked one), and the clicked one's index among them. Null when the clicked
 * one is not valid.
 */
export function lightboxArgs(all: (string | null)[], clicked: number): { srcs: string[]; index: number } | null {
  if (!isLightboxSrc(all[clicked])) return null;
  const valid: { src: string; at: number }[] = [];
  all.forEach((s, at) => {
    if (isLightboxSrc(s)) valid.push({ src: s, at });
  });
  let index = valid.findIndex((v) => v.at === clicked);
  let start = 0;
  if (valid.length > MAX_IMAGES) {
    start = Math.min(Math.max(0, index - Math.floor(MAX_IMAGES / 2)), valid.length - MAX_IMAGES);
    index -= start;
  }
  return { srcs: valid.slice(start, start + MAX_IMAGES).map((v) => v.src), index };
}

/** The lightbox page's own reading of its query (`?i=N&src=…&src=…`): only valid URLs, the index clamped. */
export function parseLightboxQuery(search: string): { srcs: string[]; index: number } {
  const p = new URLSearchParams(search);
  const srcs = p.getAll("src").filter(isLightboxSrc).slice(0, MAX_IMAGES);
  const i = Number(p.get("i"));
  const index = Number.isInteger(i) && i >= 0 && i < srcs.length ? i : 0;
  return { srcs, index };
}

/** The image `delta` steps away, wrapping around; the same index for a list of one. */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * What a key press in the lightbox window does: "close" closes the lightbox, "quit" (the close chord) closes Sidecr
 * too, "prev"/"next" step, "pass" ignores it.
 */
export function lightboxPageKey(e: KeyLike): "close" | "quit" | "prev" | "next" | "pass" {
  if (isCloseChord(e)) return e.repeat ? "pass" : "quit";
  if (e.ctrlKey || e.altKey || e.metaKey) return "pass";
  if (e.key === "Escape") return e.repeat ? "pass" : "close"; // a held Esc: the first press closes, the rest go nowhere
  if ((e.key === "f" || e.key === "F") && !e.repeat) return "close"; // F leaves fullscreen, as in the page
  if (e.key === "ArrowLeft") return "prev";
  if (e.key === "ArrowRight") return "next";
  return "pass";
}
