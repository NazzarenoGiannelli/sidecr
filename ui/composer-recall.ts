import { createRecall, shouldRecall, shouldRecallDown } from "./recall";

export interface RecallDeps {
  /** The user's earlier message texts in the displayed exchanges, oldest first. */
  getTexts(): string[];
  /** True while the switcher or the lightbox is open. */
  blocked(): boolean;
  /** Called after the composer text was replaced from here (resize, Send state). */
  changed(): void;
}

/** ArrowUp and ArrowDown in the composer walk through earlier messages. The decisions live in ui/recall.ts. */
export function attachRecall(msg: HTMLTextAreaElement, deps: RecallDeps) {
  const recall = createRecall();
  let lastRecalled: string | null = null;

  /** `recalled`: the text is an earlier message (not the user's draft coming back). */
  function put(text: string, caret: "start" | "end", recalled: boolean) {
    msg.value = text;
    // Compare against what the textarea holds, not what was assigned: it normalises CRLF line breaks to LF.
    lastRecalled = recalled ? msg.value : null;
    const at = caret === "start" ? 0 : msg.value.length;
    msg.setSelectionRange(at, at);
    deps.changed();
  }

  msg.addEventListener("keydown", (e) => {
    if (e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || deps.blocked()) return;
    if (e.key === "ArrowUp" && shouldRecall(msg.value, msg.selectionStart, lastRecalled, msg.selectionEnd)) {
      const text = recall.up(msg.value, deps.getTexts());
      if (text === null) return;
      e.preventDefault();
      put(text, "start", true);
    } else if (e.key === "ArrowDown" && shouldRecallDown(msg.value, msg.selectionEnd, lastRecalled)) {
      const text = recall.down();
      if (text === null) return;
      e.preventDefault();
      // Once the draft is back it is the user's text again, not a recalled one.
      if (recall.active()) put(text, "start", true);
      else put(text, "end", false);
    }
  });

  function reset() {
    recall.reset();
    lastRecalled = null;
  }
  // Any ordinary edit makes the text the user's own again. Programmatic changes above fire no input event.
  msg.addEventListener("input", reset);
  return { reset };
}
