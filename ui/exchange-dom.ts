/**
 * One exchange as a DOM block (a <section> keyed by the exchange id), and how a refresh updates it: only the blocks
 * whose content changed are rebuilt, so a text selection, an open tool list or a decoded image elsewhere in the
 * exchange stays as it is. Built node by node, never from markup.
 */
import type { Block, Exchange } from "../src/transcript/parse";
import { blockSigs } from "./history";
import { createIcon } from "./icons";
import { renderMarkdown, type MarkdownDeps } from "./markdown-dom";
import { renderText } from "./rich-text";

export interface ExchangeDeps {
  markdown: MarkdownDeps;
  fileUrl: (p: string) => string;
  /** Which tool lists the reader has open, by block key: a rebuilt block keeps its state. */
  openTools: Set<string>;
}

function renderTools(b: Extract<Block, { kind: "tools" }>, key: string, deps: ExchangeDeps): HTMLElement {
  const d = document.createElement("details");
  d.className = "tools";
  d.open = deps.openTools.has(key);
  d.addEventListener("toggle", () => {
    if (d.open) deps.openTools.add(key);
    else deps.openTools.delete(key);
  });
  const s = document.createElement("summary");
  s.append(createIcon("caret-right"), document.createTextNode(`${b.count} tool call${b.count === 1 ? "" : "s"}`));
  const list = document.createElement("div");
  list.className = "tool-list";
  for (const item of b.items) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = item.name || "tool";
    row.append(name);
    if (item.summary) {
      const sum = document.createElement("span");
      sum.className = "tool-summary";
      sum.textContent = item.summary;
      sum.title = item.summary;
      row.append(sum);
    }
    list.append(row);
  }
  d.append(s, list);
  return d;
}

export function renderBlock(b: Block, role: "user" | "assistant", key: string, deps: ExchangeDeps): HTMLElement {
  if (b.kind === "tools") return renderTools(b, key, deps);
  if (b.kind === "image") {
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = b.dataUrl;
    img.alt = "";
    // Which exchange and block it is: the shell's lightbox window loads it by URL (/api/image), not as a data: URL.
    const sep = key.lastIndexOf(":");
    img.dataset.ex = key.slice(0, sep);
    img.dataset.block = key.slice(sep + 1);
    return img;
  }
  const d = document.createElement("div");
  if (role === "assistant") {
    d.className = "md";
    try {
      d.append(renderMarkdown(b.text, deps.markdown));
    } catch {
      d.classList.add("md-fallback"); // keeps the line breaks
      d.textContent = b.text; // never let one reply that cannot be rendered empty the conversation
    }
  } else {
    d.append(renderText(b.text, deps.fileUrl));
  }
  return d;
}

interface Rendered {
  user: string[];
  assistant: string[];
}
const rendered = new WeakMap<HTMLElement, Rendered>();

/** Brings one message element (user or assistant) in line with its blocks, rebuilding only the changed ones. */
function syncMessage(el: HTMLElement, blocks: Block[], before: string[], role: "user" | "assistant", id: string, deps: ExchangeDeps): string[] {
  const sigs = blockSigs(blocks);
  const prefix = role === "user" ? "u" : "a";
  for (let i = 0; i < blocks.length; i++) {
    if (before[i] === sigs[i] && el.children[i]) continue;
    const node = renderBlock(blocks[i]!, role, `${id}:${prefix}${i}`, deps);
    const old = el.children[i];
    if (old) old.replaceWith(node);
    else el.append(node);
  }
  while (el.children.length > blocks.length) el.lastElementChild!.remove();
  return sigs;
}

/** A new exchange block. `old` marks a block of loaded history (rendered lazily by the browser, see style.css). */
export function createExchange(ex: Exchange, deps: ExchangeDeps, old = false): HTMLElement {
  const section = document.createElement("section");
  section.className = old ? "ex old" : "ex";
  section.dataset.id = ex.id;
  rendered.set(section, { user: [], assistant: [] });
  updateExchange(section, ex, deps);
  return section;
}

/** Updates an exchange block in place: nothing is rebuilt that did not change. */
export function updateExchange(section: HTMLElement, ex: Exchange, deps: ExchangeDeps): void {
  const state = rendered.get(section) ?? { user: [], assistant: [] };
  let user = section.querySelector<HTMLElement>(":scope > .msg.user");
  if (!user) {
    user = document.createElement("div");
    user.className = "msg user";
    section.prepend(user);
  }
  state.user = syncMessage(user, ex.user, state.user, "user", ex.id, deps);
  let assistant = section.querySelector<HTMLElement>(":scope > .msg.assistant");
  if (ex.assistant.length === 0) {
    assistant?.remove();
    state.assistant = [];
  } else {
    if (!assistant) {
      assistant = document.createElement("div");
      assistant.className = "msg assistant";
      section.append(assistant);
      state.assistant = [];
    }
    state.assistant = syncMessage(assistant, ex.assistant, state.assistant, "assistant", ex.id, deps);
  }
  rendered.set(section, state);
}
