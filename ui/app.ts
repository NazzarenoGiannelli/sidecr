import type { Exchange } from "../src/transcript/parse";
import { isWindows11 } from "../src/look";
import { sendErrorText } from "../src/send-errors";
import { defaultSettings, GROUPS, SCHEMA, validateSettings, type Settings } from "../src/settings-schema";
import type { Bounds } from "../src/window-bounds";
import type { Activity } from "./activity";
import { createActivityView } from "./activity-view";
import { attachRecall } from "./composer-recall";
import { createDraftSync } from "./draft-sync";
import { createStatusWatch } from "./notify";
import { askPermissionOnFirstPointerDown, notifyIfNeeded } from "./notify-dom";
import { createStopper } from "./stop";
import { shouldCloseOnBackdropClick } from "./backdrop";
import { boundsEqual, needsRecovery, readWindowBounds, recoveredPosition } from "./bounds";
import { createConnectionTracker } from "./connection";
import { createConversationView } from "./conversation-view";
import { escapeLayer } from "./escape";
import { headerSubtitle } from "./header";
import { createOlderLoader, type OlderPage } from "./history";
import { createFollower, parseFocusEvent, REMOTE_TEXT, type FocusTarget } from "./follow";
import { createIcon } from "./icons";
import { activatesLink, fileFailureNotice, folderFailureNotice, openedNotice, REVEAL_NOTICE, revealInstead, wantsReveal, type OpenFailure } from "./path-link";
import { cheatSheet, composerKey, matchShortcut, tooltip, tooltipWith, type Action } from "./keys";
import { createLatest } from "./latest";
import { createLightboxFullscreen, fullscreenButton } from "./lightbox-fullscreen";
import { LIGHTBOX_CLOSED_EVENT, lightboxArgs, lightboxSrcOf } from "./lightbox-window";
import { createMediaPanel } from "./media-panel";
import { JUMP_CAP, jumpScrollTop, runJump, type JumpEnd, type MediaResponse, type MediaTab } from "./media-state";
import { createNotices, type NoticeKind } from "./notices";
import type { MarkdownDeps } from "./markdown-dom";
import { createPending } from "./pending";
import { lastAnswerMarkdown, userTexts } from "./recall";
import { createCloser, createInFlight, currentWindow, onCloseRequested, SETTLE_MS, tauriOf } from "./shell";
import { isNearBottom } from "./scroll";
import { attachScrollButton } from "./scroll-button";
import { createSettingsClient } from "./settings-client";
import { createSettingsPanel, renderCheatSheet, type SettingsModel } from "./settings-panel";
import { createShellLook, cssVarsOf, isEffectsWindow } from "./shell-look";
import { topmostToggle } from "./topmost";
import { filterPanes, nthPane, paneStep, type PaneRow } from "./switcher";
import { createUnloadRunner } from "./unload";
import { createByeSender } from "./window-bye";
import { byeBlobType, createWindowSession, newWindowId, windowEventBody } from "./window-session";

interface Conv {
  pane: { id: string; title: string; status: string; agent: string | null; workspace?: string };
  machine?: string;
  exchanges: Exchange[];
  /** History in blocks (an older server leaves them out: then there is simply nothing more to load). */
  hasMore?: boolean;
  oldestId?: string | null;
  epoch?: number | null;
  truncated?: boolean;
  error?: string;
  activity?: Activity;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const conv = $("conv");
const notice = $("notice");
const tray = $("tray");
const msg = $<HTMLTextAreaElement>("msg");
const sendBtn = $<HTMLButtonElement>("send");
const fileInput = $<HTMLInputElement>("file");

let paneId = new URLSearchParams(location.search).get("pane") ?? "";
const pending = createPending((f) => URL.createObjectURL(f), (u) => URL.revokeObjectURL(u));
const latest = createLatest();
const connection = createConnectionTracker();
let source: EventSource | null = null;
let canSend = true;
let sending = false;
// Set once the stream is given up on; keeps Send disabled until another pane is chosen.
let dead: string | null = null;
// The first render of each pane scrolls to the bottom; later ones only if the reader is already near it.
let firstRender = true;
// The user's earlier messages in the displayed exchanges, for ArrowUp recall.
let lastTexts: string[] = [];
// The exchanges on screen, for Ctrl+Shift+C (copy the last answer).
let lastExchanges: Exchange[] = [];

history.replaceState(null, "", `/?pane=${encodeURIComponent(paneId)}`);

// Inside the native shell (shell/, Tauri) the window has no frame and an acrylic background: html.shell switches the
// page to translucent surfaces, and closing goes through the Tauri window API (window.close() does nothing there).
// In the Chromium window shellWin is null and nothing below changes.
const tauri = tauriOf(globalThis);
const shellWin = currentWindow(globalThis);
if (shellWin) document.documentElement.classList.add("shell");
// The keepalive requests of the unload steps, which the shell lets finish before it destroys the window.
const inFlight = createInFlight();

// Settings (server-side, settings.json). The copy cached in this window's localStorage is applied before anything
// renders, so the first frame already has the user's text size and surfaces; the server's copy replaces it when
// GET /api/settings answers, and its `settings` event keeps every open window in step (wiring near the end).
const SETTINGS_CACHE = "sidecr.settings";
function readCachedSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE);
    return raw ? validateSettings(JSON.parse(raw)) : null;
  } catch {
    return null; // no storage, or a corrupt entry: the defaults until the server answers
  }
}
let settings: Settings = readCachedSettings() ?? defaultSettings();
// Windows 11 or not, once navigator.userAgentData says (the last answer is cached, so a low strength does not jump
// at load): it decides Mica's fallback and whether the effect's tint shows, which sets the surfaces' floor.
const WIN11_CACHE = "sidecr.win11";
let win11: boolean | null = (() => {
  try {
    const v = localStorage.getItem(WIN11_CACHE);
    return v === "true" ? true : v === "false" ? false : null;
  } catch {
    return null;
  }
})();
/** The CSS side of the settings: text scale everywhere; in the shell the surface opacities and the accent. */
function applyCss(s: Settings): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVarsOf(s, shellWin !== null, win11))) root.style.setProperty(k, v);
  root.classList.toggle("opaque", shellWin !== null && !s.acrylic);
}
applyCss(settings);

/** Every close path goes through here: the unload steps once, then the window closes (see ui/shell.ts). */
function closeWindow(): void {
  closer.close();
}

// The server keeps a registry of open windows: that is how the open key can close this one and there is only ever one.
const windowSession = createWindowSession({
  id: newWindowId(globalThis.crypto),
  send: async (event) => {
    const res = await fetch("/api/window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: windowEventBody(windowSession.id, event),
    });
    return res.ok ? ((await res.json().catch(() => ({}))) as { close?: boolean }) : undefined;
  },
  // The answer to a ping carries a close request when this window's event stream could not (it was dropped).
  onClose: () => closeWindow(),
});
// A closed window leaves the registry at once; sendBeacon survives the page going away.
// Both events, once: in an Edge/Chrome app window, window.close() (the server's close push, the in-window Alt+S) fires
// beforeunload but NOT pagehide or unload (the page process is torn down first), so pagehide alone never said bye
// and the closed window stayed registered for 9 s. Not visibilitychange: a minimised window is hidden but open.
const bye = createByeSender({
  send: () => {
    windowSession.stop();
    const body = windowEventBody(windowSession.id, "bye");
    // In the shell the page destroys its own window right after: a tracked keepalive fetch is awaited first (a
    // beacon cannot be), so the bye is known to have arrived before the process ends.
    if (shellWin) inFlight.track(fetch("/api/window", { method: "POST", headers: { "content-type": byeBlobType }, body, keepalive: true }));
    else navigator.sendBeacon("/api/window", new Blob([body], { type: byeBlobType }));
  },
});
// The listeners are wired at the end of the file, with the draft and bounds flushes that go before the bye.

const notices = createNotices({
  render: (text) => {
    notice.hidden = text === null;
    notice.textContent = text ?? "";
  },
});
// "error" and "info" go away by themselves (8 s, 5 s); "sticky" is a state of the pane; null removes everything.
function showNotice(text: string | null, kind: NoticeKind = "error") {
  if (text === null) notices.clear();
  else notices.show(text, kind);
}
notice.addEventListener("mouseenter", () => notices.pause());
notice.addEventListener("mouseleave", () => notices.resume());
notice.addEventListener("click", () => notices.dismiss());

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as any).message ?? (body as any).error ?? res.statusText), { code: (body as any).error, status: res.status });
  return body as T;
}

const fileUrl = (p: string) => `/api/file?pane=${encodeURIComponent(paneId)}&path=${encodeURIComponent(p)}`;

// The clipboard API needs a secure context and a focused document; a hidden textarea and execCommand cover the rest.
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      msg.focus();
      return;
    }
  } catch {
    /* fall back below */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    ta.remove();
    msg.focus();
  }
}

const scrollButton = attachScrollButton(conv, $<HTMLButtonElement>("to-bottom"), () => msg.focus());

const stopBtn = $<HTMLButtonElement>("stop");
const activityView = createActivityView(
  { root: $("activity"), spinner: $("activity-spinner"), text: $("activity-text"), stop: stopBtn },
  () => Date.now(),
);
const stopper = createStopper({
  post: (pane) => api("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane }) }),
  getPane: () => paneId,
  setDisabled: (d) => { stopBtn.disabled = d; },
  showError: showNotice,
});
stopBtn.onclick = () => void stopper.click();
setInterval(() => activityView.tick(), 1000);

const draftSync = createDraftSync({
  load: async (pane) => (await api<{ text?: string }>(`/api/draft?pane=${encodeURIComponent(pane)}`)).text ?? "",
  save: (pane, text, keepalive) => {
    const req = fetch("/api/draft", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane, text }), keepalive });
    return keepalive ? inFlight.track(req) : req;
  },
});

const statusWatch = createStatusWatch();
askPermissionOnFirstPointerDown();

const markdownDeps: MarkdownDeps = { fileUrl, icon: createIcon, copy: copyText };

// Which tool lists the reader has open, by block key: a block that is rebuilt (its content changed) keeps its state.
const openTools = new Set<string>();

// The conversation: one keyed block per exchange (ui/conversation-view.ts). A refresh touches only the tail blocks
// that changed; scrolling to the top loads older blocks (loader below), prepended with the view held in place.
const view = createConversationView({ conv, markdown: markdownDeps, fileUrl, openTools, loadEarlier: () => void loadOlder(true) });
view.clear();
const loader = createOlderLoader({
  fetchOlder: (before, n, pane) =>
    api<OlderPage>(`/api/conversation?pane=${encodeURIComponent(pane)}&before=${encodeURIComponent(before)}&n=${n}`),
  context: () => paneId,
  apply: (page) => {
    view.prepend(page.exchanges, loader.state());
    scrollButton.update();
  },
  reset: () => resetToTail(),
  failed: (message) => showNotice(`Could not load earlier messages: ${message}`),
  changed: (state) => view.setTop(state),
});

/** Loads the next older block (the button passes retry, which also clears an error), then checks again. */
async function loadOlder(retry = false): Promise<void> {
  const r = await loader.load(settings.loadBlock, { retry });
  // A short block may leave the reader still near the top: keep going, one block at a time.
  if (r === "loaded") requestAnimationFrame(() => maybeLoadOlder());
}

function maybeLoadOlder(): void {
  if (loader.wants(conv.scrollTop)) void loadOlder();
}

/** The session file was replaced (or the window fell behind): drop the history and start again from the tail. */
function resetToTail(): void {
  view.clear();
  loader.reset();
  firstRender = true;
  void refresh();
}

conv.addEventListener("scroll", () => maybeLoadOlder(), { passive: true });

function render(c: Conv) {
  $("title").textContent = c.pane.title;
  shownTitle = c.pane.title;
  drawPin();
  if (flashFor === c.pane.id) {
    flashFor = null;
    flashHeading();
  }
  const subtitle = $("subtitle");
  const sub = headerSubtitle(c.machine, c.pane.workspace);
  subtitle.textContent = sub;
  subtitle.title = sub;
  subtitle.hidden = sub === "";
  const status = $("status");
  status.textContent = c.pane.status;
  status.className = `pill ${c.pane.status}`;
  activityView.update(c.activity);
  notifyIfNeeded(statusWatch.next(c.pane.status), c.pane.status, c.pane.title, c.pane.id, settings.notifyOnFinish);
  const nearBottom = isNearBottom(conv.scrollTop, conv.clientHeight, conv.scrollHeight, 80);
  const epoch = c.epoch ?? null;
  const { reset } = view.setTail(c.exchanges, epoch);
  if (reset) loader.reset(); // a new file, or the window fell behind: the loaded history is gone with it
  loader.fromTail({ hasMore: c.hasMore === true, oldestId: c.oldestId ?? null, epoch, truncated: c.truncated === true }, view.oldestId());
  lastTexts = userTexts(c.exchanges);
  lastExchanges = c.exchanges;
  if (firstRender || nearBottom || reset) conv.scrollTop = conv.scrollHeight;
  firstRender = false;
  scrollButton.update();
  maybeLoadOlder(); // a tail shorter than the view: fill it from the history
  if (c.error === "no-session") showNotice("This pane has no Claude Code session.", "sticky");
  else if (c.error === "transcript-not-found") showNotice("Transcript not found for this session.", "sticky");
  else if (c.error === "other-machine") showNotice(`${REMOTE_TEXT}.`, "sticky");
  else notices.clearState(); // a message that is still timing out stays
  if (dead) showNotice(dead, "sticky"); // a refresh that was already in flight when the stream was given up on
  canSend = !c.error && !dead;
  sendBtn.disabled = !canSend;
}

async function refresh() {
  if (dead) return;
  const token = latest.next();
  const forPane = paneId;
  const stale = () => !latest.isLatest(token) || forPane !== paneId;
  try {
    const c = await api<Conv>(`/api/conversation?pane=${encodeURIComponent(forPane)}`);
    if (stale()) return;
    render(c);
  } catch (e) {
    if (stale()) return;
    canSend = false;
    sendBtn.disabled = true;
    activityView.update(undefined); // what was shown is out of date now: hide the row and the Stop button
    showNotice((e as Error).message, "sticky"); // until a refresh works again
  }
}

function giveUp(text: string) {
  dead = text;
  source?.close();
  canSend = false;
  sendBtn.disabled = true;
  activityView.update(undefined); // no more updates are coming: a stale "working" row must not stay
  showNotice(text, "sticky");
}

/**
 * The window's event stream. `focusOnly`: after the shown pane is gone, the window keeps a stream without pane probes
 * (close pushes, settings and focus events), so selecting another Claude pane in herdr still moves it there.
 */
function connect(focusOnly = false) {
  source?.close();
  connection.reset();
  const es = new EventSource(
    focusOnly ? `/api/events?win=${windowSession.id}&focus=only` : `/api/events?pane=${encodeURIComponent(paneId)}&win=${windowSession.id}`,
  );
  source = es;
  es.onmessage = (e) => {
    if (source !== es) return;
    connection.message();
    if (e.data === "close") closeWindow(); // the open key was pressed again, or a newer window took over
    else if (focusOnly) return; // no pane to refresh
    else if (e.data === "gone") {
      giveUp("This pane is no longer available.");
      if (settings.followFocus !== "off") {
        connect(true);
        follower.paneGone(); // a pinned window is unpinned, so the next selection in herdr brings it back
      }
    } else void refresh();
  };
  // A settings change (from this window or another) arrives as a named event; see the settings wiring below.
  es.addEventListener("settings", (e) => {
    if (source !== es) return;
    connection.message();
    try {
      settingsClient.pushed(validateSettings(JSON.parse((e as MessageEvent<string>).data)));
    } catch {
      /* a malformed event: the next change or the next GET corrects it */
    }
  });
  // herdr's focused pane changed (src/focus.ts): ui/follow.ts decides whether this window follows.
  es.addEventListener("focus", (e) => {
    if (source !== es) return;
    connection.message(); // a focus-only stream sends nothing else: its named events prove it is alive
    try {
      const t = parseFocusEvent(JSON.parse((e as MessageEvent<string>).data));
      if (t) follower.focus(t);
    } catch {
      /* a malformed event: the next change brings a good one */
    }
  });
  es.onerror = () => {
    if (source !== es) return;
    if (connection.error(es.readyState === EventSource.CLOSED) === "disconnected") {
      giveUp("Disconnected. Close this window and open it again.");
    }
  };
}

function setPane(id: string) {
  draftSync.flush(); // the old pane's unsaved text goes out under its own id before paneId changes
  msg.value = "";
  autosize();
  lastTexts = [];
  lastExchanges = [];
  recallCtl.reset();
  paneId = id;
  dead = null;
  firstRender = true;
  openTools.clear();
  activityView.update(undefined);
  statusWatch.reset();
  history.replaceState(null, "", `/?pane=${encodeURIComponent(paneId)}`);
  pending.clear();
  renderTray();
  loader.reset(); // an older block still loading for the old pane is dropped
  view.clear();
  if (!mediaLayer.hidden) closeMedia(false); // its lists belong to the pane just left
  scrollButton.update();
  canSend = false;
  sendBtn.disabled = true;
  notices.clear(); // a message about the pane just left does not follow to the next one
  showNotice("Loading…", "sticky");
  connect();
  void refresh();
  void restoreDraft();
}

function autosize() {
  msg.style.height = "auto";
  msg.style.height = `${Math.min(msg.scrollHeight, 128)}px`;
}

// The stored draft of this pane goes into the composer only if nothing was typed there in the meantime.
async function restoreDraft() {
  const text = await draftSync.restore(paneId, () => ({ pane: paneId, value: msg.value }));
  if (text === null) return;
  msg.value = text;
  autosize();
  updateSendReady();
}

// Send is muted until there is something to send. A blocked Send is dimmed by its :disabled style instead.
function updateSendReady() {
  sendBtn.classList.toggle("ready", msg.value.trim() !== "" || pending.count > 0);
}

function renderTray() {
  updateSendReady();
  follower.composerChanged();
  tray.replaceChildren();
  pending.items.forEach((item, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (item.url) {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "";
      chip.append(img);
    }
    chip.append(document.createTextNode(item.file.name));
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.onclick = () => {
      pending.remove(i);
      renderTray();
    };
    chip.append(x);
    tray.append(chip);
  });
}

function addFiles(files: Iterable<File>) {
  const renamed: File[] = [];
  for (const f of files) {
    const name = f.name && f.name !== "image.png" ? f.name : `image-${Date.now()}.png`;
    renamed.push(new File([f], name, { type: f.type }));
  }
  pending.add(renamed);
  renderTray();
}

async function send() {
  if (sending) return;
  const text = msg.value.trim();
  if (!canSend || (!text && pending.count === 0)) return;
  sending = true;
  sendBtn.disabled = true;
  const sentPane = paneId;
  try {
    const form = new FormData();
    form.set("pane", sentPane);
    form.set("text", text);
    for (const f of pending.files()) form.append("files", f);
    await api("/api/send", { method: "POST", body: form });
    if (paneId === sentPane) {
      msg.value = "";
      msg.style.height = "auto";
      recallCtl.reset();
      pending.clear();
      renderTray();
      showNotice(null);
    }
    draftSync.clear(sentPane);
  } catch (e) {
    if (paneId === sentPane) showNotice(sendErrorText((e as { code?: string }).code, (e as Error).message));
  } finally {
    sending = false;
    sendBtn.disabled = !canSend;
    msg.focus();
    follower.sendEnded(); // a follow that waited for the send happens now
  }
}

// Switcher
const overlay = $("overlay");
const q = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("list");
let rows: PaneRow[] = [];
let shown: PaneRow[] = [];
let sel = 0;

function drawList() {
  shown = filterPanes(rows, q.value);
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  list.replaceChildren();
  shown.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = i === sel ? "sel" : "";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = r.title;
    li.append(name);
    if (r.workspace) {
      const ws = document.createElement("span");
      ws.className = "row-ws";
      ws.textContent = r.workspace;
      ws.title = r.workspace;
      li.append(ws);
    }
    const st = document.createElement("span");
    st.className = "pill";
    st.textContent = r.agentStatus;
    li.append(st);
    li.onclick = () => choose(i);
    list.append(li);
  });
}

function choose(i: number) {
  const row = shown[i];
  if (!row) return;
  closeOverlay();
  if (row.paneId === paneId) return; // already here: keep the composer and the draft as they are
  follower.manualSwitch(); // picking a pane by hand pins the window to it
  setPane(row.paneId);
}

async function openSwitcher() {
  closeLayers();
  overlay.hidden = false;
  q.value = "";
  sel = 0;
  try {
    const { panes } = await api<{ panes: PaneRow[] }>("/api/panes");
    rows = panes;
  } catch (e) {
    rows = [];
    showNotice((e as Error).message);
  }
  drawList();
  q.focus();
}

function closeOverlay() {
  overlay.hidden = true;
  msg.focus();
}

// A press and release on the dark area around the panel closes the switcher like Esc; anything that involves the panel does not.
let downOnBackdrop = false;
overlay.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === overlay; });
overlay.addEventListener("click", (e) => {
  const close = shouldCloseOnBackdropClick(downOnBackdrop, e.target === overlay);
  downOnBackdrop = false;
  if (close) closeOverlay();
});
q.addEventListener("input", () => { sel = 0; drawList(); });
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); drawList(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); drawList(); }
  else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
});

// Wiring
$("attach").append(createIcon("paperclip"));
sendBtn.append(createIcon("send"));
$("switch").append(createIcon("search"));
$("gear").append(createIcon("gear"));
$("media").append(createIcon("images"));
$("media").onclick = () => openMedia();
$("attach").onclick = () => fileInput.click();
fileInput.onchange = () => { addFiles(Array.from(fileInput.files ?? [])); fileInput.value = ""; };
sendBtn.onclick = () => void send();
$("switch").onclick = () => void openSwitcher();
$("gear").onclick = () => openSettings();
$("keys-hint").onclick = () => openCheatSheet();

// Following the pane selected in herdr (ui/follow.ts, setting followFocus). The pin button pauses and resumes it; the
// chip under the header offers a switch the window did not make on its own (the composer held something).
const pinBtn = $<HTMLButtonElement>("pin");
const followBar = $("follow-bar");
const followChip = $<HTMLButtonElement>("follow-chip");
// The title on screen (the pin's tooltip names it) and the pane whose next render flashes the header (a follow).
let shownTitle = "";
let flashFor: string | null = null;
const paneName = (t: Pick<FocusTarget, "title" | "workspace">) => (t.workspace ? `${t.workspace} · ${t.title}` : t.title);

function flashHeading(): void {
  const h = document.querySelector<HTMLElement>(".heading");
  if (!h) return;
  h.classList.remove("follow-flash");
  void h.offsetWidth; // restart the animation
  h.classList.add("follow-flash");
  h.addEventListener("animationend", () => h.classList.remove("follow-flash"), { once: true });
}

const follower = createFollower({
  state: () => ({
    mode: settings.followFocus,
    current: paneId,
    composerEmpty: msg.value.trim() === "",
    attachments: pending.count,
    sending,
  }),
  switchTo: (t) => {
    if (t.paneId === paneId) return;
    flashFor = t.paneId;
    setPane(t.paneId); // the switcher's own path: drafts, tail, activity, header
  },
  suggest: (t, discard) => {
    followBar.hidden = t === null;
    followChip.classList.toggle("confirm", discard > 0);
    if (!t) return;
    // With attachments pending the first press arms the chip: the switch drops them, so it says so and waits for a
    // second press.
    const drop = `Discard ${discard} attachment${discard === 1 ? "" : "s"} and switch`;
    followChip.textContent = discard > 0 ? drop : `herdr is on ${t.title}: switch`;
    followChip.title = tooltipWith("follow-now", discard > 0 ? `${drop} to ${paneName(t)}` : `Switch to ${paneName(t)}`);
  },
  remote: () => showNotice(`${REMOTE_TEXT}.`, "info"),
  pinChanged: () => drawPin(),
});
pinBtn.onclick = () => follower.togglePin();
followChip.onclick = () => followNow();

function drawPin(): void {
  const pinned = follower.pinned();
  const off = settings.followFocus === "off";
  pinBtn.hidden = off;
  pinBtn.replaceChildren(createIcon(pinned ? "push-pin-fill" : "push-pin"));
  pinBtn.classList.toggle("pinned", pinned);
  pinBtn.setAttribute("aria-pressed", String(pinned));
  pinBtn.title = tooltipWith("follow-pin", pinned ? `Pinned to ${shownTitle || "this session"}` : "Following herdr");
  $("title").classList.toggle("pinned", pinned && !off);
}

/** The chip and Alt+.: herdr's pane now, and following again. */
function followNow(): void {
  const r = follower.followNow();
  const t = follower.target();
  if (r === "nothing" && settings.followFocus === "off") showNotice("Following herdr is off (Settings, Behaviour).", "info");
  else if (r === "nothing" && !sending && t === null) showNotice("herdr has not moved to another session since this window opened.", "info");
  else if (r === "nothing" && !sending && !t?.isClaude) showNotice("herdr is not on a Claude session.", "info");
  else if (r === "nothing" && !sending && t?.transcript === false) showNotice("That session has no transcript yet.", "info");
  msg.focus();
}

// Always on top (shell only): Ctrl+Shift+T and the button next to the gear flip the setting like the panel does.
const ontopBtn = $<HTMLButtonElement>("ontop");
ontopBtn.append(createIcon("arrow-line-up"));
ontopBtn.hidden = shellWin === null;
ontopBtn.onclick = () => toggleTopmost();
function drawTopmost(): void {
  ontopBtn.classList.toggle("on", settings.alwaysOnTop);
  ontopBtn.setAttribute("aria-pressed", String(settings.alwaysOnTop));
}
drawTopmost();
function toggleTopmost(): void {
  if (!shellWin) return; // the browser window has no always-on-top
  const t = topmostToggle(settingsClient.current());
  void settingsClient.change("alwaysOnTop", t.value);
  showNotice(t.notice, "info");
}

/** Every tooltip with a key in it comes from the key registry (ui/keys.ts); Send follows the sendKey setting. */
function drawTooltips() {
  $("switch").title = tooltip("switcher");
  $("gear").title = tooltip("settings");
  $("media").title = tooltip("media");
  $("keys-hint").title = tooltip("cheatsheet");
  $("to-bottom").title = tooltip("scroll-bottom");
  sendBtn.title = tooltip("send", settings);
  ontopBtn.title = tooltip("always-on-top");
  drawPin();
}
drawTooltips();

// Enter or Ctrl+Enter sends, per the sendKey setting; Shift+Enter always inserts a new line (the textarea's own).
msg.addEventListener("keydown", (e) => {
  if (composerKey(e, settings.sendKey) === "send") {
    e.preventDefault();
    void send();
  }
});
msg.addEventListener("input", () => {
  updateSendReady();
  autosize();
  draftSync.typed(paneId, msg.value);
  follower.composerChanged();
});

window.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length) { e.preventDefault(); addFiles(files); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles(Array.from(e.dataTransfer?.files ?? []));
});

const lightbox = $("lightbox");
lightbox.tabIndex = -1; // focusable, so the F path can give it the focus back (see LIGHTBOX_CLOSED_EVENT)
// The thumbnail the in-page lightbox shows (the shell's fullscreen window starts from it).
let lightboxThumb: HTMLImageElement | null = null;
// What had the focus when the in-page lightbox opened (a thumbnail of the Media & links panel gets it back).
let lightboxReturn: HTMLElement | null = null;
// Real fullscreen for the lightbox. In the shell: a second native window covering the monitor (open_lightbox, see
// shell/src-tauri/src/lightbox.rs). In the Chromium window: the Fullscreen API on the in-page lightbox.
const fsButton = $<HTMLButtonElement>("lightbox-fs");
const lightboxFs = createLightboxFullscreen({ now: () => Date.now() });
function drawFullscreenButton() {
  const { icon, label } = fullscreenButton(lightboxFs.fullscreen());
  fsButton.replaceChildren(createIcon(icon));
  fsButton.title = label;
  fsButton.setAttribute("aria-label", label);
}
drawFullscreenButton();

/** Opens the shell's lightbox window on this thumbnail, with the conversation's other images to step through. */
function openLightboxWindow(thumb: HTMLImageElement): void {
  const invoke = tauri?.core?.invoke;
  // From the Media & links panel: step through the panel's images; else through the conversation's.
  const thumbs = thumb.classList.contains("media-img") ? mediaPanel.images() : Array.from(conv.querySelectorAll<HTMLImageElement>("img.thumb"));
  const all = thumbs.map((t) => lightboxSrcOf({ src: t.src, ex: t.dataset.ex, block: t.dataset.block }, location.origin, paneId));
  const args = lightboxArgs(all, thumbs.indexOf(thumb));
  if (!invoke || !args) {
    showNotice("This image cannot be shown fullscreen.");
    return;
  }
  invoke("open_lightbox", args).catch(() => showNotice("Fullscreen is not available here."));
}

async function toggleFullscreen() {
  if (shellWin) {
    if (lightboxThumb) openLightboxWindow(lightboxThumb);
    return;
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (lightbox.requestFullscreen) await lightbox.requestFullscreen();
    else throw new Error("no fullscreen");
  } catch {
    showNotice("Fullscreen is not available here.");
  }
}
function openLightbox(thumb: HTMLImageElement, keepLayers = false) {
  if (!keepLayers) closeLayers(); // from the Media & links panel the panel stays open under it
  if (lightboxThumb === null) lightboxReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lightboxThumb = thumb;
  (lightbox.querySelector("img") as HTMLImageElement).src = thumb.src;
  lightbox.hidden = false;
}
function closeLightbox() {
  lightbox.hidden = true;
  lightboxThumb = null;
  // Back to the thumbnail it was opened from in the Media & links panel.
  if (!mediaLayer.hidden && lightboxReturn?.isConnected) lightboxReturn.focus();
  lightboxReturn = null;
  if (lightboxFs.shouldExitOnClose()) void Promise.resolve(document.exitFullscreen?.()).catch(() => {});
}
// The button follows the real state, whichever way fullscreen began or ended (the button, F, or the browser's own Esc).
document.addEventListener("fullscreenchange", () => {
  lightboxFs.changed(document.fullscreenElement === lightbox);
  drawFullscreenButton();
});
fsButton.onclick = (e) => { e.stopPropagation(); void toggleFullscreen(); };
const recallCtl = attachRecall(msg, {
  getTexts: () => lastTexts,
  blocked: () => !overlay.hidden || !lightbox.hidden || !settingsLayer.hidden || !cheatLayer.hidden || !mediaLayer.hidden,
  changed: () => {
    autosize();
    updateSendReady();
    draftSync.typed(paneId, msg.value); // recalled text is a draft like typed text (a follow switch keeps it)
    follower.composerChanged();
  },
});
const isThumb = (el: EventTarget | null): el is HTMLImageElement => el instanceof HTMLImageElement && el.classList.contains("thumb");
// Shift+click must not extend a text selection on the way.
conv.addEventListener("mousedown", (e) => { if (e.shiftKey && isThumb(e.target)) e.preventDefault(); });
conv.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (isThumb(el)) {
    if (e.shiftKey) {
      // Straight to fullscreen: the shell's own window, or the in-page lightbox in real fullscreen (Chromium).
      if (shellWin) openLightboxWindow(el);
      else {
        openLightbox(el);
        void toggleFullscreen();
      }
    } else openLightbox(el);
    return;
  }
  const a = el.closest("a.link") as HTMLElement | null;
  if (!a) return;
  e.preventDefault();
  openLink(a, e.shiftKey);
});
// Shift+click on a file link must not extend a text selection on the way (it shows the file in its folder).
conv.addEventListener("mousedown", (e) => {
  if (e.shiftKey && (e.target as HTMLElement).closest?.("a.link")) e.preventDefault();
});
const postOpen = (kind: string | undefined, target: string | undefined) =>
  api("/api/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane: paneId, kind, target }),
  });
/**
 * Opens a link of the conversation through /api/open. A folder that is gone or is not a folder is a notice, never an error
 * page. A file of a type that is not opened from a click is shown in its folder instead (so is any file on Shift+click).
 */
function openLink(a: HTMLElement, shift = false) {
  const kind = a.dataset.kind;
  const target = a.dataset.target;
  const reveal = () =>
    postOpen("reveal", target).then(
      () => showNotice(REVEAL_NOTICE, "info"),
      (err) => showNotice(fileFailureNotice(err as OpenFailure)),
    );
  if (wantsReveal(kind, { shiftKey: shift })) {
    void reveal();
    return;
  }
  postOpen(kind, target).then(
    (res) => {
      const note = kind === "dir" ? openedNotice(res) : null;
      if (note) showNotice(note, "info");
    },
    (err: OpenFailure) => {
      if (revealInstead(kind, err)) void reveal();
      else showNotice(kind === "dir" ? folderFailureNotice(err) : kind === "path" ? fileFailureNotice(err) : err.message || "The link did not open");
    },
  );
}
// Folder links are in the tab order: Enter or Space opens the focused one.
conv.addEventListener("keydown", (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.("a.link.dir") as HTMLElement | null;
  if (!a || !activatesLink(e)) return;
  e.preventDefault();
  openLink(a);
});
lightbox.onclick = () => closeLightbox();

// Settings panel and cheat sheet: overlay panels like the switcher (one layer at a time, Esc or a click around the
// panel closes them, focus goes back to the composer).
const settingsLayer = $("settings");
const cheatLayer = $("cheatsheet");
const mediaLayer = $("media-layer");
const settingsPanelEl = settingsLayer.querySelector(".panel") as HTMLElement;
const cheatPanelEl = cheatLayer.querySelector(".panel") as HTMLElement;

/** Closes the switcher, the settings and the cheat sheet without moving the focus (another layer opens next). */
function closeLayers() {
  overlay.hidden = true;
  if (!settingsLayer.hidden) void settingsClient.flush();
  settingsLayer.hidden = true;
  cheatLayer.hidden = true;
  if (!mediaLayer.hidden) mediaPanel.close();
  mediaLayer.hidden = true;
  $("media").setAttribute("aria-expanded", "false");
}
function openSettings() {
  if (!lightbox.hidden) return;
  closeLayers();
  settingsLayer.hidden = false;
  settingsPanel.focusFirst();
}
function closeSettings() {
  void settingsClient.flush();
  settingsLayer.hidden = true;
  msg.focus();
}
function drawCheatSheet() {
  renderCheatSheet(cheatPanelEl, cheatSheet({ inShell: shellWin !== null, settings }), () => closeCheatSheet());
}
function openCheatSheet() {
  if (!lightbox.hidden) return;
  closeLayers();
  drawCheatSheet();
  cheatLayer.hidden = false;
  cheatPanelEl.focus();
}
function closeCheatSheet() {
  cheatLayer.hidden = true;
  msg.focus();
}
// The Media & links panel (ui/media-panel.ts): the session's images and links, newest first, paged from /api/media.
const mediaPanel = createMediaPanel({
  root: mediaLayer.querySelector(".panel") as HTMLElement,
  fetchPage: <T,>(kind: MediaTab, cursor: string | null) =>
    api<MediaResponse<T>>(`/api/media?pane=${encodeURIComponent(paneId)}&kind=${kind}&limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  openImage: (img, shift) => {
    if (shift && shellWin) return openLightboxWindow(img);
    openLightbox(img, true);
    if (shift) void toggleFullscreen();
  },
  openLink: (url) => {
    api("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane: paneId, kind: "url", target: url }) }).catch((err) =>
      showNotice((err as Error).message),
    );
  },
  copyLink: (url) => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    copyText(url)
      .then(() => showNotice("Copied the link.", "info"))
      .catch(() => showNotice("Could not copy the link."))
      .finally(() => back?.focus()); // copyText leaves the focus in the composer; the panel is still open
  },
  goTo: (id) => void goToMessage(id),
  close: () => closeMedia(),
});
function openMedia() {
  if (!lightbox.hidden) return;
  if (!mediaLayer.hidden) return closeMedia(); // the shortcut toggles it
  closeLayers();
  mediaLayer.hidden = false;
  $("media").setAttribute("aria-expanded", "true");
  mediaPanel.open();
}
function closeMedia(focusComposer = true) {
  mediaPanel.close();
  mediaLayer.hidden = true;
  $("media").setAttribute("aria-expanded", "false");
  if (focusComposer) msg.focus();
}

/**
 * Puts an exchange block a third of the way down the view. The block and the one before it are laid out for real
 * (not left to content-visibility's size estimate), and the position is corrected for a few frames while the blocks
 * coming into view settle their real size.
 */
function placeAtThird(el: HTMLElement, forPane: string): void {
  for (const s of [el, el.previousElementSibling]) if (s instanceof HTMLElement) s.classList.remove("old");
  const place = () => {
    const want = jumpScrollTop(conv.scrollTop, el.getBoundingClientRect().top, conv.getBoundingClientRect().top, conv.clientHeight);
    if (Math.abs(want - conv.scrollTop) > 1) conv.scrollTop = want;
  };
  place();
  // The correction stops at once when the reader scrolls or presses a key: it never fights them.
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const t of USER_SCROLL_EVENTS) conv.removeEventListener(t, stop);
    window.removeEventListener("keydown", stop, true);
  };
  for (const t of USER_SCROLL_EVENTS) conv.addEventListener(t, stop, { passive: true });
  window.addEventListener("keydown", stop, true);
  let frames = 0;
  const settle = () => {
    if (stopped || paneId !== forPane || !el.isConnected) return stop();
    place();
    scrollButton.update();
    if (++frames < PLACE_FRAMES) requestAnimationFrame(settle);
    else stop();
  };
  requestAnimationFrame(settle);
}
/** What a reader does to scroll: any of these ends a jump's position correction. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown"] as const;
/** Frames of position correction after a jump (about 130 ms). */
const PLACE_FRAMES = 8;

/**
 * "Go to message": loads older blocks from the oldest loaded one until the exchange is in (at most JUMP_CAP
 * exchanges), then puts it a third of the way down the view and flashes it. "Jump to latest" brings the reader back.
 */
async function goToMessage(id: string): Promise<void> {
  closeMedia(false);
  const forPane = paneId;
  const start = view.size();
  const end = await runJump({
    found: () => view.section(id) !== undefined,
    loaded: () => view.size() - start,
    hasMore: () => loader.hasMore(),
    loading: () => loader.loading(),
    failed: () => loader.failed(),
    load: () => loader.load(50),
    here: () => paneId === forPane,
    wait: () => new Promise((r) => setTimeout(r, 50)),
  });
  if (end === "left") return; // another pane now: nothing to say about this one
  if (end !== "found") {
    const text: Record<Exclude<JumpEnd, "found" | "left">, string> = {
      cap: `That message is more than ${JUMP_CAP} exchanges back: showing the oldest loaded.`,
      missing: "That message is not in the history that can be loaded.",
      error: "Could not load earlier messages, so the jump stopped. Press Retry at the top, then Go to message again.",
      changed: "The session changed while jumping, so the jump stopped.",
      stuck: "The jump to that message did not finish.",
    };
    showNotice(text[end], end === "cap" || end === "missing" ? "info" : "error");
    if (end === "changed") return; // the window went back to the latest messages
    const oldest = view.oldestId();
    const el = oldest ? view.section(oldest) : undefined;
    if (el) placeAtThird(el, forPane);
    if (end === "error") (document.querySelector("#history-top button:not([hidden])") as HTMLElement | null)?.focus({ preventScroll: true });
    else msg.focus({ preventScroll: true });
    return;
  }
  const el = view.section(id)!;
  placeAtThird(el, forPane);
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
  msg.focus({ preventScroll: true });
}

for (const [layer, close] of [[settingsLayer, closeSettings], [cheatLayer, closeCheatSheet], [mediaLayer, () => closeMedia()]] as const) {
  let down = false;
  layer.addEventListener("pointerdown", (e) => { down = e.target === layer; });
  layer.addEventListener("click", (e) => {
    const shut = shouldCloseOnBackdropClick(down, e.target === layer);
    down = false;
    if (shut) close();
  });
}

/** Alt+Up / Alt+Down or Alt+1..9: another pane of the switcher's list. */
async function goToPane(pick: (rows: PaneRow[]) => PaneRow | null) {
  try {
    const { panes } = await api<{ panes: PaneRow[] }>("/api/panes");
    const row = pick(panes);
    if (row && row.paneId !== paneId) {
      follower.manualSwitch();
      setPane(row.paneId);
    }
  } catch (e) {
    showNotice((e as Error).message);
  }
}

async function copyLastAnswer() {
  const text = lastAnswerMarkdown(lastExchanges);
  if (text === null) {
    showNotice("There is no answer to copy yet.", "info");
    return;
  }
  try {
    await copyText(text);
    showNotice("Copied the last answer.", "info");
  } catch {
    showNotice("Could not copy the answer.");
  }
}

/** What a shortcut of the key registry does (ui/keys.ts defines the keys; this is the only dispatch). */
function runAction(action: Action, arg?: number) {
  switch (action) {
    case "close": return closeWindow();
    case "switcher": return void openSwitcher();
    case "settings": return openSettings();
    case "cheatsheet": return openCheatSheet();
    case "prev-pane": return void goToPane((rows) => paneStep(rows, paneId, -1));
    case "next-pane": return void goToPane((rows) => paneStep(rows, paneId, 1));
    case "nth-pane": return void goToPane((rows) => nthPane(rows, arg ?? 0));
    case "scroll-bottom":
      conv.scrollTop = conv.scrollHeight;
      return scrollButton.update();
    case "copy-answer": return void copyLastAnswer();
    case "lightbox-fullscreen": return void toggleFullscreen();
    case "media": return openMedia();
    case "follow-pin": return follower.togglePin();
    case "follow-now": return followNow();
    case "always-on-top": return toggleTopmost();
  }
}

/** A text field where keys type characters (the composer, the switcher's search); a slider or a button is not one. */
const isTextField = (t: EventTarget | null): boolean =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && (t.type === "text" || t.type === "search"));

window.addEventListener("keydown", (e) => {
  const lightboxOpen = !lightbox.hidden;
  const typing = isTextField(e.target);
  // The Chromium window's real fullscreen: an Esc leaves it (and only that), or is the same press that already did.
  if (e.key === "Escape") {
    const fsKey = lightboxFs.key(e, { lightboxOpen, typing });
    if (fsKey === "exit") { e.preventDefault(); void Promise.resolve(document.exitFullscreen?.()).catch(() => {}); return; }
    if (fsKey === "swallow") { e.preventDefault(); return; }
  }
  const hit = matchShortcut(e, { typing, lightboxOpen, inShell: shellWin !== null });
  if (hit) {
    if (hit.shortcut.preventDefault !== false) e.preventDefault();
    runAction(hit.shortcut.handler as Action, hit.chord.arg);
    return;
  }
  if (e.key === "Escape" && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    const layer = escapeLayer({
      lightboxOpen,
      overlayOpen: !overlay.hidden,
      settingsOpen: !settingsLayer.hidden,
      cheatSheetOpen: !cheatLayer.hidden,
      mediaOpen: !mediaLayer.hidden,
      trayCount: pending.count,
      noticeShown: notices.dismissible(),
      composerEmpty: msg.value.trim() === "",
      repeat: e.repeat,
    });
    if (layer !== "none") e.preventDefault();
    if (layer === "lightbox") closeLightbox();
    else if (layer === "overlay") closeOverlay();
    else if (layer === "settings") closeSettings();
    else if (layer === "cheatsheet") closeCheatSheet();
    else if (layer === "media") closeMedia();
    else if (layer === "tray") { pending.clear(); renderTray(); }
    else if (layer === "notice") notices.dismiss();
    else if (layer === "close") closeWindow(); // Alt+S, type, send, Esc: back to the terminal
  }
});

// Remember the window placement (the server keeps it in window.json; open.ts passes it to the browser on launch).
// A saved position can point at a monitor that is no longer there: if the window is essentially off the screen,
// bring it back before the poll starts, so the poll saves the corrected bounds.
function recoverIfOffScreen() {
  if (window.screenX <= -30000 || window.screenY <= -30000) return; // minimised, not off-screen
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const area: Bounds = { x: s.availLeft ?? 0, y: s.availTop ?? 0, w: s.availWidth, h: s.availHeight };
  const b = readWindowBounds(window);
  if (!(area.w > 0 && area.h > 0 && b.w > 0 && b.h > 0) || !needsRecovery(b, area)) return;
  const r = recoveredPosition(b, area);
  if (r.w !== b.w || r.h !== b.h) window.resizeTo(r.w, r.h);
  window.moveTo(r.x, r.y);
}
// The shell places the window itself (and moves one from a missing monitor to the primary); moveTo does not move it.
if (!shellWin) recoverIfOffScreen();

let sentBounds: Bounds | null = null;
function reportBounds(keepalive = false) {
  // A minimised Windows window reports a position of about -32000.
  if (window.screenX <= -30000 || window.screenY <= -30000) return;
  const b = readWindowBounds(window);
  if (boundsEqual(sentBounds, b)) return;
  sentBounds = b;
  const req = fetch("/api/window-bounds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
    keepalive,
  });
  if (keepalive) inFlight.track(req);
  req.catch(() => {
    if (sentBounds === b) sentBounds = null; // retry on the next tick
  });
}
setInterval(() => reportBounds(), 1000);

// As the page goes away, in this order: the unsent draft, the window placement, the bye last. The draft write and
// the bounds report are keepalive fetches and the bye a beacon, so the browser finishes them after the page is gone.
// (In the shell the bye is a keepalive fetch too, and closeWindow waits for all three before destroying the window.)
// beforeunload as well as pagehide: window.close() in an app window fires only beforeunload.
// A slider save still waiting for its debounce goes out with them (keepalive), before the bye.
const unload = createUnloadRunner([() => draftSync.flush(), () => void settingsClient.flush({ keepalive: true }), () => reportBounds(true), () => bye.sendOnce()]);
window.addEventListener("beforeunload", () => unload.run());
window.addEventListener("pagehide", () => unload.run());
window.addEventListener("pageshow", (e) => { // restored from the back/forward cache
  if (!e.persisted) return;
  bye.rearm();
  unload.rearm();
  windowSession.start();
});

const closer = createCloser({
  unload: () => unload.run(),
  win: shellWin,
  settle: () => inFlight.settled(SETTLE_MS),
  // closeBrowser defaults to window.close() inside ui/shell.ts: no other ui file calls it (test/ui-close-guard.test.ts).
});

// The shell's frameless window: the header drags it (buttons stay clickable: with "deep" the whole header is a drag
// region except clickable elements), and carries the minimise and close buttons the missing title bar would have.
// An OS close (Alt+F4, the taskbar) arrives as the shell's close request and takes the same path as Alt+S.
if (shellWin) {
  const header = document.querySelector("header");
  if (header) {
    header.setAttribute("data-tauri-drag-region", "deep");
    const winButton = (icon: "minus" | "x", title: string, label: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `icon-btn win-btn${icon === "x" ? " win-close" : ""}`;
      b.title = title;
      b.setAttribute("aria-label", label);
      b.append(createIcon(icon));
      b.onclick = onClick;
      return b;
    };
    header.append(
      winButton("minus", "Minimise", "Minimise", () => void shellWin.minimize().catch(() => {})),
      winButton("x", tooltip("close"), "Close", () => closeWindow()),
    );
  }
  void onCloseRequested(tauri, () => closeWindow());
  // The lightbox window closed (Esc, F, a click): the shell gives this window the focus back. On the F path the
  // in-page lightbox is still open: it takes the focus (so the next F toggles again instead of typing an "f" in
  // the composer under it). Otherwise the composer does.
  void tauri?.event?.listen?.(LIGHTBOX_CLOSED_EVENT, () => {
    if (!lightbox.hidden) lightbox.focus({ preventScroll: true });
    else if (!mediaLayer.hidden) (lightboxReturn ?? (mediaLayer.querySelector(".panel") as HTMLElement)).focus();
    else if (overlay.hidden && settingsLayer.hidden && cheatLayer.hidden) msg.focus();
  }).catch(() => {});
}

// Settings wiring. The panel is built from the bundled schema at once and rebuilt from the server's when GET
// answers. Every change goes through the client: applied here first, then saved (PUT, debounced for the slider);
// the server's `settings` event (connect()) brings changes made in another window.
const shellLook = shellWin && isEffectsWindow(shellWin) ? createShellLook(shellWin, () => win11) : null;
type UaData = { platform?: string; getHighEntropyValues?(hints: string[]): Promise<{ platform?: string; platformVersion?: string }> };
const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
if (shellLook && uaData?.getHighEntropyValues) {
  // Mica and Blur need Windows 11: once the version is known, an unsupported choice falls back to Acrylic.
  uaData
    .getHighEntropyValues(["platformVersion"])
    .then((v) => {
      win11 = isWindows11(v.platform ?? uaData.platform, v.platformVersion);
      try {
        if (win11 !== null) localStorage.setItem(WIN11_CACHE, String(win11));
      } catch {
        /* no storage: worked out again next time */
      }
      applyCss(settings);
      void shellLook.apply(settings);
    })
    .catch(() => {});
}
const settingsClient = createSettingsClient({
  put: async (patch, opts) => {
    try {
      const init: RequestInit = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch), keepalive: opts?.keepalive === true };
      // An unload-time save is tracked, so the shell lets it finish before it destroys the window.
      const r = opts?.keepalive ? await inFlight.track(api<{ settings: unknown }>("/api/settings", init)) : await api<{ settings: unknown }>("/api/settings", init);
      return validateSettings(r.settings);
    } catch {
      return null;
    }
  },
  apply: (next, prev) => {
    settings = next;
    applyCss(next);
    try {
      localStorage.setItem(SETTINGS_CACHE, JSON.stringify(next));
    } catch {
      /* no storage: the next window starts from the defaults until the server answers */
    }
    void shellLook?.apply(next);
    drawTooltips();
    drawTopmost();
    if (!prev || prev.followFocus !== next.followFocus) follower.modeChanged(next.followFocus);
    settingsPanel.update(next);
    if (!cheatLayer.hidden) drawCheatSheet();
    if (prev && prev.exchangesShown !== next.exchangesShown) void refresh();
  },
  failed: () => showNotice("Could not save the settings."),
});
const settingsPanel = createSettingsPanel({
  root: settingsPanelEl,
  inShell: shellWin !== null,
  change: (id, value, opts) => void settingsClient.change(id, value, opts),
  reset: () => void settingsClient.reset(),
  openShortcuts: () => openCheatSheet(),
  shortcutsTip: tooltip("cheatsheet"),
  close: () => closeSettings(),
});
settingsPanel.build({ schema: { groups: [...GROUPS], settings: [...SCHEMA] }, about: { version: "", stateDir: "" } }, settings);
settingsClient.load(settings); // the cached copy: the shell's effect and topmost flag follow it at once
void (async () => {
  try {
    const r = await api<{ settings: unknown } & SettingsModel>("/api/settings");
    const fromServer = validateSettings(r.settings);
    settingsPanel.build({ schema: r.schema, about: r.about }, fromServer);
    settingsClient.load(fromServer);
  } catch {
    /* an older server without settings: the bundled schema and the cached copy stay */
  }
})();

windowSession.start();
connect();
void refresh();
void restoreDraft();
msg.focus();
