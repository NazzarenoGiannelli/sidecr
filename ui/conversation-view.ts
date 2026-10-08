/**
 * The conversation element: a top row (load earlier / loading / beginning of the session) followed by one keyed
 * block per exchange. A refresh updates or appends only the tail blocks that changed; older blocks are prepended
 * with the visible content held in place. The decisions are pure, in ui/history.ts.
 */
import type { Exchange } from "../src/transcript/parse";
import { createExchange, updateExchange, type ExchangeDeps } from "./exchange-dom";
import { anchoredScrollTop, pickAnchor, planTail, type TopState } from "./history";

export interface ConversationViewDeps extends ExchangeDeps {
  conv: HTMLElement;
  /** The "Load earlier" / "Retry" button was pressed. */
  loadEarlier: () => void;
}

export function createConversationView(deps: ConversationViewDeps) {
  const { conv } = deps;
  const sections = new Map<string, HTMLElement>();
  let epoch: number | null = null;

  const top = document.createElement("div");
  top.id = "history-top";
  top.className = "history-top";
  top.setAttribute("aria-live", "polite");
  top.hidden = true;
  const topText = document.createElement("span");
  const topButton = document.createElement("button");
  topButton.type = "button";
  topButton.className = "history-btn";
  topButton.onclick = () => deps.loadEarlier();
  top.append(topText, topButton);

  const ids = (): string[] => Array.from(conv.querySelectorAll<HTMLElement>(":scope > section.ex"), (s) => s.dataset.id ?? "");

  function clear(): void {
    sections.clear();
    epoch = null;
    conv.replaceChildren(top);
    setTop("hidden");
  }

  function setTop(state: TopState): void {
    top.hidden = state === "hidden";
    top.dataset.state = state;
    topButton.hidden = state !== "more" && state !== "error";
    topText.hidden = state === "more";
    if (state === "loading") topText.textContent = "Loading earlier…";
    else if (state === "error") topText.textContent = "Could not load earlier messages.";
    else if (state === "start") topText.textContent = "Beginning of the session";
    else if (state === "truncated") topText.textContent = "Older history not indexed";
    else topText.textContent = "";
    topButton.textContent = state === "error" ? "Retry" : "Load earlier";
  }

  /** Renders the tail. Returns whether the window was reset (everything before it dropped). */
  function setTail(exchanges: Exchange[], tailEpoch: number | null): { reset: boolean } {
    if (top.parentElement !== conv) conv.prepend(top);
    const plan = planTail(ids(), exchanges.map((e) => e.id), tailEpoch === epoch);
    if (plan.reset) {
      for (const s of sections.values()) s.remove();
      sections.clear();
    }
    for (const id of plan.remove) {
      sections.get(id)?.remove();
      sections.delete(id);
    }
    epoch = tailEpoch;
    let previous: HTMLElement | null = null;
    for (const ex of exchanges) {
      let el = sections.get(ex.id);
      if (el) updateExchange(el, ex, deps);
      else {
        el = createExchange(ex, deps);
        sections.set(ex.id, el);
        if (previous) previous.after(el);
        else {
          // Before the first tail block the window already has (the tail grew backwards), else at the end.
          const next = exchanges.map((e) => sections.get(e.id)).find((s) => s && s !== el && s.isConnected);
          if (next) next.before(el);
          else conv.append(el);
        }
      }
      previous = el;
    }
    return { reset: plan.reset };
  }

  /** Prepends older exchanges (oldest first), keeping what the reader sees exactly where it was. */
  function prepend(exchanges: Exchange[], topState: TopState): void {
    const fresh = exchanges.filter((e) => !sections.has(e.id));
    const blocks = Array.from(conv.querySelectorAll<HTMLElement>(":scope > section.ex"));
    const viewTop = conv.getBoundingClientRect().top;
    const i = pickAnchor(blocks.map((b) => b.getBoundingClientRect().bottom), viewTop);
    const anchor = i >= 0 ? blocks[i]! : null;
    const before = anchor?.getBoundingClientRect().top ?? 0;
    const frag = document.createDocumentFragment();
    for (const ex of fresh) {
      const el = createExchange(ex, deps, true);
      sections.set(ex.id, el);
      frag.append(el);
    }
    top.after(frag);
    setTop(topState);
    if (anchor) {
      const after = anchor.getBoundingClientRect().top;
      // The browser's own scroll anchoring may already have kept it in place: then after === before and this is a no-op.
      if (after !== before) conv.scrollTop = anchoredScrollTop(conv.scrollTop, before, after);
    }
  }

  return {
    clear,
    setTail,
    prepend,
    setTop,
    epoch: () => epoch,
    oldestId: (): string | null => conv.querySelector<HTMLElement>(":scope > section.ex")?.dataset.id ?? null,
    size: () => sections.size,
    section: (id: string): HTMLElement | undefined => sections.get(id),
  };
}

export type ConversationView = ReturnType<typeof createConversationView>;
