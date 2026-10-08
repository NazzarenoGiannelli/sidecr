/**
 * The Media & links panel: an overlay like the settings, with two tabs. Images is a grid of small lazy thumbnails
 * (a click or Enter opens the lightbox, Shift+click fullscreen); Links is a list with the host, a title, how many
 * times it came up, and Open (through /api/open), Copy and Go to message. Both page in as the reader scrolls, from
 * GET /api/media. Built node by node, never from markup; a link is never an href.
 */
import { createIcon } from "./icons";
import {
  createMediaList,
  indexingNote,
  MEDIA_TABS,
  POLL_MAX_FAILURES,
  pollDelay,
  tabFromKey,
  type MediaImageItem,
  type MediaLinkItem,
  type MediaResponse,
  type MediaTab,
} from "./media-state";

export interface MediaPanelDeps {
  /** The panel element inside the layer. */
  root: HTMLElement;
  fetchPage<T>(kind: MediaTab, cursor: string | null): Promise<MediaResponse<T>>;
  /** Open an image in the lightbox (shift: straight to fullscreen); `all` are the panel's images, for stepping. */
  openImage(img: HTMLImageElement, shift: boolean): void;
  openLink(url: string): void;
  copyLink(url: string): void;
  goTo(exchangeId: string): void;
  close(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

const button = (className: string, label: string, title = label): HTMLButtonElement => {
  const b = el("button", className);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
};

/** "2 Oct, 14:05" from an ISO time; nothing when there is none. */
function when(at?: string): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function createMediaPanel(deps: MediaPanelDeps) {
  let tab: MediaTab = "images";
  let open = false;
  let poll: ReturnType<typeof setTimeout> | null = null;
  // Failed progress polls in a row: each waits longer, and polling stops after POLL_MAX_FAILURES (said in the note).
  let pollFailures = 0;

  const head = el("div", "panel-head");
  const title = el("h2", "panel-title", "Media & links");
  const tabs = el("div", "media-tabs");
  tabs.setAttribute("role", "tablist");
  const tabButtons = new Map<MediaTab, HTMLButtonElement>();
  for (const t of MEDIA_TABS) {
    const b = el("button", "media-tab", t === "images" ? "Images" : "Links");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.id = `media-tab-${t}`;
    b.setAttribute("aria-controls", "media-body");
    b.onclick = () => select(t, true);
    tabButtons.set(t, b);
    tabs.append(b);
  }
  const close = button("icon-btn panel-close", "Close", "Close (Esc)");
  close.append(createIcon("x"));
  close.onclick = () => deps.close();
  head.append(title, tabs, close);
  const note = el("div", "media-note");
  note.setAttribute("aria-live", "polite");
  const body = el("div", "panel-body media-body");
  body.id = "media-body";
  body.setAttribute("role", "tabpanel");
  const grid = el("div", "media-grid");
  const list = el("ul", "media-links");
  const empty = el("div", "media-empty");
  const retry = button("history-btn media-retry", "Retry");
  retry.textContent = "Retry";
  body.append(grid, list, empty);
  deps.root.replaceChildren(head, note, body);

  const images = createMediaList<MediaImageItem>({
    fetch: (cursor) => deps.fetchPage<MediaImageItem>("images", cursor),
    keyOf: (x) => `${x.exchangeId}|${x.kind}|${x.i}|${x.src}`,
    changed: (added) => {
      for (const x of added) grid.append(imageTile(x));
      draw();
    },
  });
  const links = createMediaList<MediaLinkItem>({
    fetch: (cursor) => deps.fetchPage<MediaLinkItem>("links", cursor),
    keyOf: (x) => x.url,
    changed: (added) => {
      for (const x of added) list.append(linkRow(x));
      draw();
    },
  });
  const current = () => (tab === "images" ? images : links);

  function imageTile(x: MediaImageItem): HTMLElement {
    const tile = el("div", "media-tile");
    const at = when(x.at);
    const nth = grid.children.length + 1;
    const name = `image ${nth}${at ? `, ${at}` : ""}`;
    const open = button("media-thumb", `Open ${name}`, `Open (Shift+click: fullscreen)${at ? ` · ${at}` : ""}`);
    const img = el("img", "media-img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = x.thumb;
    img.dataset.ex = x.exchangeId;
    img.onerror = () => tile.classList.add("broken");
    open.append(img);
    open.onclick = (e) => deps.openImage(img, e.shiftKey);
    open.addEventListener("mousedown", (e) => {
      if (e.shiftKey) e.preventDefault(); // no text selection on the way to fullscreen
    });
    const foot = el("div", "media-tile-foot");
    const go = button("media-go", `Go to the message with ${name}`, "Go to message");
    go.textContent = "Go to message";
    go.onclick = () => deps.goTo(x.exchangeId);
    foot.append(go);
    tile.append(open, foot);
    return tile;
  }

  function linkRow(x: MediaLinkItem): HTMLElement {
    const li = el("li", "media-link");
    const main = el("div", "ml-main");
    main.append(el("span", "ml-title", x.title ?? x.host));
    const meta = el("span", "ml-meta", `${x.host}${x.count > 1 ? ` · ${x.count}×` : ""}${x.at ? ` · ${when(x.at)}` : ""}`);
    const url = el("span", "ml-url", x.url);
    url.title = x.url;
    main.append(meta, url);
    const actions = el("div", "ml-actions");
    const label = x.title ?? x.host;
    const openB = button("icon-btn ml-open", `Open link: ${label}`, "Open in the browser");
    openB.append(createIcon("arrow-square-out"));
    openB.onclick = () => deps.openLink(x.url);
    const copy = button("icon-btn ml-copy", `Copy link: ${label}`, "Copy link");
    copy.append(createIcon("copy"));
    copy.onclick = () => deps.copyLink(x.url);
    const go = button("media-go", `Go to the message with link: ${label}`, "Go to message");
    go.textContent = "Go to message";
    go.onclick = () => deps.goTo(x.exchangeId);
    actions.append(openB, copy, go);
    li.append(main, actions);
    return li;
  }

  function draw(): void {
    for (const [t, b] of tabButtons) {
      b.setAttribute("aria-selected", String(t === tab));
      b.tabIndex = t === tab ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", `media-tab-${tab}`);
    grid.hidden = tab !== "images";
    list.hidden = tab !== "links";
    const l = current();
    const st = l.status();
    note.textContent =
      st === "error" ? "" : pollFailures >= POLL_MAX_FAILURES ? "Indexing paused: Sidecr's server did not answer. Close and reopen the panel to try again." : indexingNote(l.last());
    note.hidden = note.textContent === "";
    empty.replaceChildren();
    empty.hidden = !(st === "empty" || st === "error" || st === "loading" || st === "idle");
    if (st === "empty") empty.textContent = tab === "images" ? "No images in this session yet." : "No links in this session yet.";
    else if (st === "loading" || st === "idle") empty.textContent = "Loading…";
    else if (st === "error") {
      empty.append(el("span", "", `Could not load the ${tab}: ${l.error() ?? ""}`), retry);
    }
    schedule();
  }

  /** Loads the next page when the reader is near the end; while the index grows, asks again a little later. */
  function maybeMore(): void {
    if (!open) return;
    const l = current();
    const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (l.wantsMore(remaining)) void l.load();
  }

  function schedule(): void {
    if (poll) clearTimeout(poll);
    poll = null;
    if (!open || pollFailures >= POLL_MAX_FAILURES) return;
    const l = current();
    if (l.growing() || l.wantsMore(body.scrollHeight - body.scrollTop - body.clientHeight)) {
      const list = l;
      poll = setTimeout(() => {
        poll = null;
        if (!open || current() !== list) return;
        const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
        // Near the end: the next page (it also brings the progress). Elsewhere: just the progress, from the top.
        if (list.wantsMore(remaining)) {
          void list.load();
          return;
        }
        void list.peek().then((r) => {
          if (!open || current() !== list) return;
          if (r === "failed") pollFailures++;
          else if (r === "ok") pollFailures = 0;
          // A failure or a skipped peek never ends polling silently: it is scheduled again (later, after a failure).
          if (r !== "ok") {
            draw();
            return;
          }
        });
      }, pollDelay(pollFailures));
    }
  }

  function select(t: MediaTab, focus: boolean): void {
    tab = t;
    if (current().status() === "idle") void current().load();
    draw();
    if (focus) tabButtons.get(t)!.focus();
    maybeMore();
  }

  retry.onclick = () => {
    void current().load();
  };
  body.addEventListener("scroll", () => maybeMore(), { passive: true });
  deps.root.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const t = tabFromKey(e, tab);
    if (t && t !== tab) {
      e.preventDefault();
      select(t, true);
    }
  });

  return {
    /** Opens on the tab it was on, with fresh lists (the session may have moved on). */
    open(): void {
      open = true;
      pollFailures = 0;
      images.reset();
      links.reset();
      grid.replaceChildren();
      list.replaceChildren();
      body.scrollTop = 0;
      select(tab, true);
    },
    close(): void {
      open = false;
      if (poll) clearTimeout(poll);
      poll = null;
    },
    isOpen: () => open,
    tab: () => tab,
    /** The panel's images, in order: the lightbox steps through them. */
    images: (): HTMLImageElement[] => Array.from(grid.querySelectorAll<HTMLImageElement>("img.media-img")),
  };
}

export type MediaPanel = ReturnType<typeof createMediaPanel>;
