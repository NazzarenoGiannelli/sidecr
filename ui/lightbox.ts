// The shell's lightbox window (/lightbox.html): one image at a time, contain-fitted on black. Esc, F or a click
// closes it; Left/Right step through the images the main window passed; the close chord (Alt+S, Ctrl+Shift+J)
// asks the shell to close Sidecr by navigating to the close signal, which the shell cancels and acts on. It closes itself with the Tauri window API
// (its capability allows only close and destroy); outside the shell it never runs.
import { CLOSE_SIDECR_QUERY, isCloseSignal, lightboxPageKey, parseLightboxQuery, stepIndex } from "./lightbox-window";

interface LightboxWin {
  destroy(): Promise<void>;
  close(): Promise<void>;
}

const tauri = (globalThis as { __TAURI__?: { window?: { getCurrentWindow?: () => LightboxWin } } }).__TAURI__;
const img = document.getElementById("image") as HTMLImageElement;
const counter = document.getElementById("counter") as HTMLElement;
const { srcs } = parseLightboxQuery(location.search);
let index = parseLightboxQuery(location.search).index;

function show(): void {
  const src = srcs[index];
  if (src === undefined) return;
  img.src = src;
  counter.hidden = srcs.length < 2;
  counter.textContent = `${index + 1} / ${srcs.length}`;
}

let closing = false;
function closeSelf(): void {
  if (closing) return;
  closing = true;
  const w = tauri?.window?.getCurrentWindow?.();
  if (!w) return;
  void w.destroy().catch(() => w.close().catch(() => {}));
}

window.addEventListener("keydown", (e) => {
  const action = lightboxPageKey(e);
  if (action === "pass") return;
  e.preventDefault();
  if (action === "close") closeSelf();
  else if (action === "quit") location.replace(`/lightbox.html?${CLOSE_SIDECR_QUERY[0]}=${CLOSE_SIDECR_QUERY[1]}`);
  else if (srcs.length > 1) {
    index = stepIndex(index, action === "next" ? 1 : -1, srcs.length);
    show();
  }
});
window.addEventListener("click", () => closeSelf());
window.addEventListener("contextmenu", (e) => e.preventDefault());

if (isCloseSignal(location.search)) closeSelf(); // a shell that let the signal through: at least close this window
else show();
window.focus();
