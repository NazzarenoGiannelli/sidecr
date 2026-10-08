import type { Exchange } from "../src/transcript/parse";

/** The user's own message texts in the displayed exchanges, oldest first. Images and exchanges without text are skipped. */
export function userTexts(exchanges: Exchange[]): string[] {
  const out: string[] = [];
  for (const ex of exchanges) {
    const text = ex.user
      .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim() !== "") out.push(text);
  }
  return out;
}

/**
 * Should ArrowUp recall a message? Only from an empty composer, or when the composer still holds the text
 * recalled last and the caret is at the very start with nothing selected (so ArrowUp keeps its normal meaning
 * inside text the user wrote, and over a selection).
 */
export function shouldRecall(value: string, selectionStart: number, lastRecalled: string | null, selectionEnd = selectionStart): boolean {
  if (value === "") return true;
  return lastRecalled !== null && value === lastRecalled && selectionStart === 0 && selectionEnd === selectionStart;
}

/** Should ArrowDown move toward newer messages? Only while the recalled text is untouched and the caret is on its last line. */
export function shouldRecallDown(value: string, selectionEnd: number, lastRecalled: string | null): boolean {
  return lastRecalled !== null && value === lastRecalled && !value.slice(selectionEnd).includes("\n");
}

/** Walks through the user's earlier messages with ArrowUp and ArrowDown, and brings the draft back at the end. */
export function createRecall() {
  let index = -1; // position in `list`; -1 while not recalling
  let list: string[] = [];
  let stash = "";
  const reset = () => {
    index = -1;
    list = [];
    stash = "";
  };
  return {
    /** Older message, or null when there is none (nothing sent yet, or already at the oldest). */
    up(current: string, texts: string[]): string | null {
      if (texts.length === 0) return null;
      list = texts;
      if (index === -1) {
        stash = current;
        index = texts.length - 1;
        return texts[index];
      }
      index = Math.min(index, texts.length - 1);
      if (index === 0) return null;
      index -= 1;
      return texts[index];
    },
    /** Newer message, then the stashed draft; null when no recall is in progress. */
    down(): string | null {
      if (index === -1) return null;
      if (index < list.length - 1) {
        index += 1;
        return list[index];
      }
      const draft = stash;
      reset();
      return draft;
    },
    /** True while a recalled message is in the composer (between the first up and the draft coming back). */
    active(): boolean {
      return index !== -1;
    },
    /** The user edited the text: forget the position and the stash. */
    reset,
  };
}

/**
 * The last answer as Markdown text (Ctrl+Shift+C): the text blocks of the last exchange that has any assistant text,
 * joined by a blank line, exactly as the transcript holds them. Null when there is none.
 */
export function lastAnswerMarkdown(exchanges: Exchange[]): string | null {
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const parts = exchanges[i]!.assistant
      .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text.trim())
      .filter((t) => t !== "");
    if (parts.length > 0) return parts.join("\n\n");
  }
  return null;
}
