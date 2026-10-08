import { describe, expect, test } from "bun:test";
import { ERROR_NOTICE_MS, INFO_NOTICE_MS, createNotices } from "../ui/notices";
import { escapeLayer } from "../ui/escape";

function setup() {
  let clock = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const shown: Array<string | null> = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: clock + ms, fn });
      return id;
    },
    clear: (id: unknown) => void pending.delete(id as number),
  };
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = end;
  };
  const n = createNotices({ render: (t) => { shown.push(t); }, timers, now: () => clock });
  return { n, shown, advance, last: () => shown[shown.length - 1], timersPending: () => pending.size };
}

describe("notice timing", () => {
  test("the durations are 5 s and 8 s", () => {
    expect(INFO_NOTICE_MS).toBe(5000);
    expect(ERROR_NOTICE_MS).toBe(8000);
  });

  test("a normal notice goes after 5 s", () => {
    const { n, advance, last } = setup();
    n.show("saved", "info");
    advance(4999);
    expect(last()).toBe("saved");
    advance(1);
    expect(last()).toBeNull();
  });

  test("an error goes after 8 s", () => {
    const { n, advance, last } = setup();
    n.show("file not found", "error");
    advance(7999);
    expect(last()).toBe("file not found");
    advance(1);
    expect(last()).toBeNull();
  });

  test("a newer notice replaces the older one and restarts the timer", () => {
    const { n, advance, last } = setup();
    n.show("first", "error");
    advance(6000);
    n.show("second", "error");
    expect(last()).toBe("second");
    advance(7999);
    expect(last()).toBe("second"); // 6000 + 7999 would be past the first one's deadline
    advance(1);
    expect(last()).toBeNull();
  });

  test("a newer notice of another kind uses its own duration", () => {
    const { n, advance, last } = setup();
    n.show("error", "error");
    n.show("info", "info");
    advance(5000);
    expect(last()).toBeNull();
  });

  test("a sticky notice (a state of the pane) stays", () => {
    const { n, advance, last, timersPending } = setup();
    n.show("This pane has no Claude Code session.", "sticky");
    advance(60_000);
    expect(last()).toBe("This pane has no Claude Code session.");
    expect(timersPending()).toBe(0);
  });

  test("when a timed notice ends, the sticky one underneath comes back", () => {
    const { n, advance, last } = setup();
    n.show("Disconnected.", "sticky");
    n.show("send failed", "error");
    expect(last()).toBe("send failed");
    advance(8000);
    expect(last()).toBe("Disconnected.");
  });

  test("a sticky state arriving while a message is on screen waits for it; the same state again changes nothing", () => {
    const { n, advance, last, shown } = setup();
    n.show("send failed", "error");
    n.show("No session.", "sticky");
    n.show("No session.", "sticky"); // a refresh repeats it
    expect(last()).toBe("send failed");
    expect(shown).toEqual(["send failed"]);
    advance(8000);
    expect(last()).toBe("No session.");
  });

  test("clearState removes the state notice but not a message that is still timing out", () => {
    const { n, advance, last } = setup();
    n.show("No session.", "sticky");
    n.clearState();
    expect(last()).toBeNull();
    n.show("No session.", "sticky");
    n.show("oops", "error");
    n.clearState();
    expect(last()).toBe("oops");
    advance(8000);
    expect(last()).toBeNull(); // the state was cleared underneath it
  });

  test("clear removes everything, the sticky one too, and stops the timer", () => {
    const { n, advance, last, timersPending } = setup();
    n.show("Loading…", "sticky");
    n.show("oops", "error");
    n.clear();
    expect(last()).toBeNull();
    expect(timersPending()).toBe(0);
    advance(10_000);
    expect(last()).toBeNull();
    n.dismiss(); // nothing underneath any more
    expect(last()).toBeNull();
  });
});

describe("dismissing", () => {
  test("dismiss removes a timed notice at once and cancels its timer", () => {
    const { n, last, timersPending } = setup();
    n.show("oops", "error");
    expect(n.dismissible()).toBe(true);
    n.dismiss();
    expect(last()).toBeNull();
    expect(timersPending()).toBe(0);
    expect(n.dismissible()).toBe(false);
  });

  test("dismiss leaves a sticky notice alone", () => {
    const { n, last } = setup();
    n.show("Disconnected.", "sticky");
    expect(n.dismissible()).toBe(false);
    n.dismiss();
    expect(last()).toBe("Disconnected.");
  });

  test("dismissible is false with nothing shown", () => {
    expect(setup().n.dismissible()).toBe(false);
  });
});

describe("hovering pauses the timer", () => {
  test("the time left is kept while the pointer is over the notice", () => {
    const { n, advance, last } = setup();
    n.show("oops", "error");
    advance(3000);
    n.pause();
    advance(60_000);
    expect(last()).toBe("oops");
    n.resume();
    advance(4999); // 8000 - 3000 = 5000 left
    expect(last()).toBe("oops");
    advance(1);
    expect(last()).toBeNull();
  });

  test("a notice shown while paused starts fresh and is not paused", () => {
    const { n, advance, last } = setup();
    n.show("one", "info");
    n.pause();
    n.show("two", "info");
    advance(5000);
    expect(last()).toBeNull();
  });

  test("resume without a pause, or after the notice went, does nothing", () => {
    const { n, advance, last, timersPending } = setup();
    n.resume();
    n.show("x", "info");
    n.resume();
    advance(5000);
    expect(last()).toBeNull();
    n.pause();
    n.resume();
    expect(timersPending()).toBe(0);
  });

  test("pause on a sticky notice does nothing", () => {
    const { n, last, timersPending } = setup();
    n.show("state", "sticky");
    n.pause();
    n.resume();
    expect(last()).toBe("state");
    expect(timersPending()).toBe(0);
  });
});

describe("Esc and the notice", () => {
  test("a dismissible notice is the last thing Esc acts on, after the other layers", () => {
    const base = { lightboxOpen: false, overlayOpen: false, trayCount: 0 };
    expect(escapeLayer({ ...base, noticeShown: true })).toBe("notice");
    expect(escapeLayer({ ...base, trayCount: 2, noticeShown: true })).toBe("tray");
    expect(escapeLayer({ ...base, overlayOpen: true, noticeShown: true })).toBe("overlay");
    expect(escapeLayer({ ...base, lightboxOpen: true, noticeShown: true })).toBe("lightbox");
    expect(escapeLayer({ ...base, noticeShown: false })).toBe("none");
    expect(escapeLayer(base)).toBe("none");
  });
});
