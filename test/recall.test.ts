import { describe, expect, test } from "bun:test";
import type { Exchange } from "../src/transcript/parse";
import { createRecall, lastAnswerMarkdown, shouldRecall, shouldRecallDown, userTexts } from "../ui/recall";

describe("shouldRecall (ArrowUp)", () => {
  test("an empty composer always recalls", () => {
    expect(shouldRecall("", 0, null)).toBe(true);
    expect(shouldRecall("", 0, "old")).toBe(true);
  });
  test("a composer with the user's own text never recalls", () => {
    expect(shouldRecall("typed", 0, null)).toBe(false);
    expect(shouldRecall("typed", 0, "something else")).toBe(false);
    expect(shouldRecall("typed", 5, null)).toBe(false);
  });
  test("recalled text recalls again only with the caret at position 0", () => {
    expect(shouldRecall("old", 0, "old")).toBe(true);
    expect(shouldRecall("old", 3, "old")).toBe(false);
    expect(shouldRecall("old", 1, "old")).toBe(false);
  });
  test("recalled text that was edited is the user's own text again", () => {
    expect(shouldRecall("old!", 0, "old")).toBe(false);
  });
  test("recalled text with a selection does not recall: ArrowUp then collapses the selection like in any text field", () => {
    expect(shouldRecall("old", 0, "old", 3)).toBe(false); // select all
    expect(shouldRecall("old", 0, "old", 1)).toBe(false);
    expect(shouldRecall("old", 0, "old", 0)).toBe(true); // caret only
    expect(shouldRecall("old", 0, "old")).toBe(true); // no selectionEnd given: same as the start
  });
  test("an empty composer recalls whatever the selection says", () => {
    expect(shouldRecall("", 0, null, 0)).toBe(true);
  });
});

describe("shouldRecallDown (ArrowDown)", () => {
  test("only while the composer still holds the recalled text", () => {
    expect(shouldRecallDown("old", 0, "old")).toBe(true);
    expect(shouldRecallDown("old", 3, "old")).toBe(true);
    expect(shouldRecallDown("old!", 0, "old")).toBe(false);
    expect(shouldRecallDown("", 0, "old")).toBe(false);
  });
  test("never without a recall in progress", () => {
    expect(shouldRecallDown("", 0, null)).toBe(false);
    expect(shouldRecallDown("typed", 5, null)).toBe(false);
  });
  test("in a multi-line text the caret must be on the last line, so ArrowDown still moves through the lines", () => {
    expect(shouldRecallDown("one\ntwo", 0, "one\ntwo")).toBe(false);
    expect(shouldRecallDown("one\ntwo", 4, "one\ntwo")).toBe(true);
    expect(shouldRecallDown("one\ntwo", 7, "one\ntwo")).toBe(true);
  });
});

describe("createRecall", () => {
  const texts = ["first", "second", "third"];

  test("with nothing to recall, up gives null and down gives null", () => {
    const r = createRecall();
    expect(r.up("draft", [])).toBeNull();
    expect(r.down()).toBeNull();
  });
  test("the first up returns the newest text", () => {
    const r = createRecall();
    expect(r.up("", texts)).toBe("third");
  });
  test("each further up goes one older and stops at the oldest", () => {
    const r = createRecall();
    expect(r.up("", texts)).toBe("third");
    expect(r.up("third", texts)).toBe("second");
    expect(r.up("second", texts)).toBe("first");
    expect(r.up("first", texts)).toBeNull();
    expect(r.up("first", texts)).toBeNull();
  });
  test("down walks back toward newer texts and ends on the stashed draft", () => {
    const r = createRecall();
    r.up("my draft", texts);
    r.up("third", texts);
    r.up("second", texts);
    expect(r.down()).toBe("second");
    expect(r.down()).toBe("third");
    expect(r.down()).toBe("my draft");
  });
  test("after the stash came back, down has nothing more to do", () => {
    const r = createRecall();
    r.up("my draft", texts);
    expect(r.down()).toBe("my draft");
    expect(r.down()).toBeNull();
  });
  test("an empty stash comes back as an empty string, not null", () => {
    const r = createRecall();
    r.up("", texts);
    expect(r.down()).toBe("");
  });
  test("at the oldest text, down still goes newer", () => {
    const r = createRecall();
    r.up("", texts);
    r.up("", texts);
    r.up("", texts);
    r.up("", texts);
    expect(r.down()).toBe("second");
  });
  test("a single text: up, then nothing older, then down gives the stash", () => {
    const r = createRecall();
    expect(r.up("d", ["only"])).toBe("only");
    expect(r.up("only", ["only"])).toBeNull();
    expect(r.down()).toBe("d");
  });
  test("only the first up stashes: later ups do not overwrite the stash with a recalled text", () => {
    const r = createRecall();
    r.up("original", texts);
    r.up("third", texts);
    r.down();
    expect(r.down()).toBe("original");
  });
  test("active is true from the first up until the draft comes back or reset is called", () => {
    const r = createRecall();
    expect(r.active()).toBe(false);
    r.up("d", texts);
    expect(r.active()).toBe(true);
    r.down();
    expect(r.active()).toBe(false);
    r.up("d", texts);
    r.reset();
    expect(r.active()).toBe(false);
  });
  test("reset forgets the position and the stash", () => {
    const r = createRecall();
    r.up("old draft", texts);
    r.up("third", texts);
    r.reset();
    expect(r.down()).toBeNull();
    expect(r.up("new draft", texts)).toBe("third");
    r.up("third", texts);
    r.up("second", texts);
    expect(r.down()).toBe("second");
    expect(r.down()).toBe("third");
    expect(r.down()).toBe("new draft");
  });
  test("a new message arriving mid-recall keeps the walk on the same texts", () => {
    const r = createRecall();
    expect(r.up("", texts)).toBe("third");
    const grown = [...texts, "fourth"];
    expect(r.up("third", grown)).toBe("second");
    expect(r.down()).toBe("third");
  });
  test("a list that shrank is clamped, not read out of range", () => {
    const r = createRecall();
    r.up("", texts);
    r.up("", texts);
    r.up("", texts);
    expect(r.up("", ["only"])).toBeNull();
    expect(r.down()).toBe("");
  });
});

describe("userTexts", () => {
  const ex = (id: string, user: Exchange["user"]): Exchange => ({ id, user, assistant: [] });
  test("one text per exchange, oldest first", () => {
    expect(userTexts([ex("a", [{ kind: "text", text: "hello" }]), ex("b", [{ kind: "text", text: "again" }])])).toEqual(["hello", "again"]);
  });
  test("the text blocks of one exchange are joined with a line break; images and tool blocks are skipped", () => {
    const e = ex("a", [
      { kind: "text", text: "look" },
      { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
      { kind: "text", text: "at this" },
    ]);
    expect(userTexts([e])).toEqual(["look\nat this"]);
  });
  test("exchanges with no text are skipped", () => {
    const e1 = ex("a", [{ kind: "image", dataUrl: "data:image/png;base64,AAAA" }]);
    const e2 = ex("b", [{ kind: "text", text: "   " }]);
    const e3 = ex("c", []);
    expect(userTexts([e1, e2, e3, ex("d", [{ kind: "text", text: "kept" }])])).toEqual(["kept"]);
  });
  test("no exchanges, no texts", () => {
    expect(userTexts([])).toEqual([]);
  });
});

describe("lastAnswerMarkdown (Ctrl+Shift+C)", () => {
  const ex = (id: string, assistant: Exchange["assistant"]): Exchange => ({ id, user: [{ kind: "text", text: "q" }], assistant });
  test("the text blocks of the last answer, joined by a blank line, as the transcript holds them", () => {
    const list = [
      ex("1", [{ kind: "text", text: "old" }]),
      ex("2", [{ kind: "text", text: "# Title\n\n- a" }, { kind: "tools", count: 1, items: [] }, { kind: "text", text: "`code`" }]),
    ];
    expect(lastAnswerMarkdown(list)).toBe("# Title\n\n- a\n\n`code`");
  });
  test("an exchange still without text is skipped for the one before", () => {
    expect(lastAnswerMarkdown([ex("1", [{ kind: "text", text: "done" }]), ex("2", [{ kind: "tools", count: 2, items: [] }])])).toBe("done");
  });
  test("none at all: null", () => {
    expect(lastAnswerMarkdown([])).toBeNull();
    expect(lastAnswerMarkdown([ex("1", [])])).toBeNull();
  });
});
