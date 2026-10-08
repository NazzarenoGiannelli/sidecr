import { describe, expect, test } from "bun:test";
import { attachRecall } from "../ui/composer-recall";

/** Just enough of a textarea: a value that normalises \r\n like the browser does, a selection, and listeners. */
function fakeTextarea() {
  const handlers: Record<string, ((e: any) => void)[]> = {};
  let value = "";
  let start = 0;
  let end = 0;
  const area = {
    get value() {
      return value;
    },
    set value(v: string) {
      value = v.split("\r\n").join("\n").split("\r").join("\n");
      start = end = value.length;
    },
    get selectionStart() {
      return start;
    },
    get selectionEnd() {
      return end;
    },
    setSelectionRange(a: number, b: number) {
      start = a;
      end = b;
    },
    addEventListener(type: string, h: (e: any) => void) {
      (handlers[type] ??= []).push(h);
    },
    press(key: string) {
      const e = { key, isComposing: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const h of handlers.keydown ?? []) h(e);
      return e;
    },
  };
  return area;
}

function setup(texts: string[]) {
  const area = fakeTextarea();
  let changed = 0;
  attachRecall(area as unknown as HTMLTextAreaElement, { getTexts: () => texts, blocked: () => false, changed: () => { changed++; } });
  return { area, changes: () => changed };
}

describe("attachRecall", () => {
  test("ArrowUp walks back through earlier messages", () => {
    const { area } = setup(["first", "second"]);
    expect(area.press("ArrowUp").defaultPrevented).toBe(true);
    expect(area.value).toBe("second");
    expect(area.selectionStart).toBe(0);
    expect(area.press("ArrowUp").defaultPrevented).toBe(true);
    expect(area.value).toBe("first");
  });

  test("a message with \\r\\n line breaks recalls and recalls again: the browser's normalised value still compares equal", () => {
    const { area } = setup(["oldest", "line one\r\nline two"]);
    area.press("ArrowUp");
    expect(area.value).toBe("line one\nline two"); // the textarea normalised the breaks
    const second = area.press("ArrowUp"); // caret is at 0 and the value is the recalled text: it must go on
    expect(second.defaultPrevented).toBe(true);
    expect(area.value).toBe("oldest");
  });

  test("ArrowDown after a \\r\\n recall brings the next text back", () => {
    const { area } = setup(["oldest", "a\r\nb"]);
    area.press("ArrowUp");
    area.press("ArrowUp");
    expect(area.value).toBe("oldest");
    area.setSelectionRange(area.value.length, area.value.length);
    area.press("ArrowDown");
    expect(area.value).toBe("a\nb");
    area.setSelectionRange(area.value.length, area.value.length);
    expect(area.press("ArrowDown").defaultPrevented).toBe(true); // the stash (empty draft) comes back
    expect(area.value).toBe("");
  });

  test("with the whole recalled text selected, ArrowUp is left to the browser", () => {
    const { area } = setup(["first", "second"]);
    area.press("ArrowUp");
    area.setSelectionRange(0, area.value.length); // select all
    const e = area.press("ArrowUp");
    expect(e.defaultPrevented).toBe(false);
    expect(area.value).toBe("second");
  });

  test("with a caret only, ArrowUp at the start of the recalled text goes on", () => {
    const { area } = setup(["first", "second"]);
    area.press("ArrowUp");
    area.setSelectionRange(0, 0);
    expect(area.press("ArrowUp").defaultPrevented).toBe(true);
    expect(area.value).toBe("first");
  });
});
