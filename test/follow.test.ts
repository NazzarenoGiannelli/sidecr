import { describe, expect, test } from "bun:test";
import { createFollower, decideFollow, parseFocusEvent, REMOTE_TEXT, type FocusTarget, type FollowInputs, type FollowMode } from "../ui/follow";
import type { TimerApi } from "../ui/timers";

const claude = (id: string, over: Partial<FocusTarget> = {}): FocusTarget => ({
  paneId: id, agent: "claude", isClaude: true, title: `t-${id}`, workspace: "personal", remote: false, ...over,
});
const shell = (id: string): FocusTarget => ({ paneId: id, agent: null, isClaude: false, title: id, workspace: "docs", remote: false });

const base: FollowInputs = { mode: "idle", pinned: false, current: "w1:p1", target: claude("w1:p2"), composerEmpty: true, attachments: 0, sending: false };
const decide = (over: Partial<FollowInputs>) => decideFollow({ ...base, ...over });

describe("decideFollow", () => {
  test("idle: switches with an empty composer, offers the chip with text or an attachment", () => {
    expect(decide({})).toEqual({ kind: "switch", paneId: "w1:p2" });
    expect(decide({ composerEmpty: false })).toEqual({ kind: "suggest", target: claude("w1:p2") });
    expect(decide({ attachments: 1 })).toEqual({ kind: "suggest", target: claude("w1:p2") });
  });

  test("auto: switches with text in the composer (the draft is kept per pane), offers only for a pending attachment", () => {
    expect(decide({ mode: "auto", composerEmpty: false })).toEqual({ kind: "switch", paneId: "w1:p2" });
    expect(decide({ mode: "auto", attachments: 2 }).kind).toBe("suggest");
  });

  test("off: never, whatever the state", () => {
    for (const composerEmpty of [true, false]) expect(decide({ mode: "off", composerEmpty })).toEqual({ kind: "none" });
  });

  test("pinned: nothing in auto or idle", () => {
    for (const mode of ["auto", "idle"] as FollowMode[]) expect(decide({ mode, pinned: true })).toEqual({ kind: "none" });
  });

  test("the pane already shown, no focus yet, or a pane that is not Claude: nothing", () => {
    expect(decide({ target: claude("w1:p1") })).toEqual({ kind: "none" });
    expect(decide({ target: null })).toEqual({ kind: "none" });
    expect(decide({ target: shell("w7:p1") })).toEqual({ kind: "none" });
    expect(decide({ target: { ...claude("w1:p3"), agent: "codex", isClaude: false } })).toEqual({ kind: "none" });
  });

  test("a Claude pane without a transcript: nothing (no switch into an empty screen), unless it is the pane shown", () => {
    expect(decide({ target: claude("w1:p2", { transcript: false }) })).toEqual({ kind: "none" });
    expect(decide({ mode: "auto", composerEmpty: false, target: claude("w1:p2", { transcript: false }) })).toEqual({ kind: "none" });
    expect(decide({ target: claude("w1:p2", { transcript: true }) }).kind).toBe("switch");
  });
  test("a send in flight: wait, in every mode that follows", () => {
    for (const mode of ["auto", "idle"] as FollowMode[]) expect(decide({ mode, sending: true })).toEqual({ kind: "wait" });
  });

  test("another machine's Claude pane: say so, even with text in the composer; not when pinned or off", () => {
    const r = claude("w1:p1A", { remote: true });
    expect(decide({ target: r, composerEmpty: false })).toEqual({ kind: "remote", target: r });
    expect(decide({ target: r, pinned: true })).toEqual({ kind: "none" });
    expect(decide({ target: r, mode: "off" })).toEqual({ kind: "none" });
  });
});

describe("parseFocusEvent", () => {
  test("a server event, field by field", () => {
    expect(parseFocusEvent({ paneId: "w1:p2", agent: "claude", isClaude: true, title: "x", workspace: "personal", remote: false, transcript: true })).toEqual({
      paneId: "w1:p2", agent: "claude", isClaude: true, title: "x", workspace: "personal", remote: false, transcript: true,
    });
    expect(parseFocusEvent({ paneId: "w7:p1", agent: null, isClaude: false })).toEqual({ paneId: "w7:p1", agent: null, isClaude: false, title: "w7:p1", workspace: "", remote: false });
    expect(parseFocusEvent({ paneId: "w1:pR", isClaude: true, remote: true, machine: "lab" })).toMatchObject({ remote: true, machine: "lab" });
  });
  test("anything else is not one", () => {
    for (const bad of [null, "x", 3, {}, { paneId: "" , isClaude: true }, { paneId: "w1:p1" }, { paneId: 7, isClaude: true }, { paneId: "x".repeat(201), isClaude: true }]) {
      expect(parseFocusEvent(bad)).toBeNull();
    }
  });
  test("the remote text", () => {
    expect(REMOTE_TEXT).toBe("This agent runs on another machine; its conversation is not available here");
  });
});

/** Timers driven by hand. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: TimerApi = {
    set: (fn, ms) => (due.set(++seq, { at: t + ms, fn }), seq),
    clear: (h) => void due.delete(h as number),
  };
  return {
    timers,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        due.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

/** A window around a follower: the composer, the pane shown, and a log of what the follower asked for. */
function rig(mode: FollowMode = "idle", current = "w1:p1") {
  const clock = fakeTimers();
  const w = { mode, current, text: "", attachments: 0, sending: false };
  const log: string[] = [];
  let chip: FocusTarget | null = null;
  const f = createFollower({
    state: () => ({ mode: w.mode, current: w.current, composerEmpty: w.text.trim() === "", attachments: w.attachments, sending: w.sending }),
    switchTo: (t) => {
      log.push(`switch ${t.paneId}`);
      w.current = t.paneId;
    },
    suggest: (t, discard) => {
      chip = t;
      log.push(t ? `chip ${t.paneId}${discard > 0 ? ` discard ${discard}` : ""}` : "chip off");
    },
    remote: (t) => void log.push(`remote ${t.paneId}`),
    pinChanged: (p) => void log.push(p ? "pinned" : "following"),
    timers: clock.timers,
  });
  return { f, w, log, clock, chip: () => chip };
}

describe("the follower", () => {
  test("the first focus is where herdr already is when the window opens: no switch; the next change follows", () => {
    const r = rig();
    r.f.focus(claude("w1:p9")); // herdr on another pane than the one the window was opened on
    r.clock.advance(500);
    expect(r.log).toEqual([]);
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["switch w1:p2"]);
  });

  test("debounce: quick sidebar navigation switches once, to where it settles", () => {
    const r = rig();
    r.f.focus(claude("w1:p1"));
    for (const id of ["w1:p2", "w1:p3", "w1:p4"]) {
      r.f.focus(claude(id));
      r.clock.advance(60);
    }
    expect(r.log).toEqual([]);
    r.clock.advance(150);
    expect(r.log).toEqual(["switch w1:p4"]);
  });

  test("the same focus again (the stream reconnected after a switch) does nothing", () => {
    const r = rig();
    r.f.focus(claude("w1:p1"));
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.f.focus(claude("w1:p2"));
    r.clock.advance(500);
    expect(r.log).toEqual(["switch w1:p2"]);
  });

  test("a pane that is not Claude: no switch and no flicker; back on a Claude pane follows", () => {
    const r = rig();
    r.f.focus(claude("w1:p1"));
    r.f.focus(shell("w7:p1"));
    r.clock.advance(300);
    expect(r.log).toEqual([]);
    r.f.focus(claude("w1:p3"));
    r.clock.advance(150);
    expect(r.log).toEqual(["switch w1:p3"]);
  });

  test("idle with text: the chip instead of a switch; it follows herdr; emptying the composer switches", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "half a thought";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["chip w1:p2"]);
    r.f.focus(claude("w1:p3"));
    r.clock.advance(150);
    expect(r.chip()?.paneId).toBe("w1:p3");
    r.w.text = "";
    r.f.composerChanged();
    expect(r.log.at(-1)).toBe("chip w1:p3"); // not at once: the user may be rewriting
    r.clock.advance(999);
    expect(r.log.at(-1)).toBe("chip w1:p3");
    r.clock.advance(1);
    expect(r.log.slice(-2)).toEqual(["chip off", "switch w1:p3"]);
  });

  test("idle: typing again during the quiet second cancels the switch; emptying again restarts the wait", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "first try";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.w.text = "";
    r.f.composerChanged();
    r.clock.advance(600);
    r.w.text = "s";
    r.f.composerChanged();
    r.clock.advance(2000);
    expect(r.log).toEqual(["chip w1:p2"]);
    r.w.text = "";
    r.f.composerChanged();
    r.clock.advance(999);
    expect(r.log).toEqual(["chip w1:p2"]);
    r.clock.advance(1);
    expect(r.log.at(-1)).toBe("switch w1:p2");
  });

  test("idle: a send switches at once (no quiet wait); pinning during the wait cancels it", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "msg";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.w.text = ""; // the send cleared the composer: renderTray reports it, then the send ends
    r.f.composerChanged();
    r.f.sendEnded();
    expect(r.log.at(-1)).toBe("switch w1:p2");

    const q = rig("idle");
    q.f.focus(claude("w1:p1"));
    q.w.text = "msg";
    q.f.focus(claude("w1:p2"));
    q.clock.advance(150);
    q.w.text = "";
    q.f.composerChanged();
    q.f.togglePin();
    q.clock.advance(5000);
    expect(q.log).toEqual(["chip w1:p2", "pinned", "chip off"]);
  });

  test("idle: an attachment counts as a non-empty composer", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.attachments = 1;
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["chip w1:p2"]);
    r.w.attachments = 0;
    r.f.composerChanged();
    r.clock.advance(1000);
    expect(r.log.at(-1)).toBe("switch w1:p2");
  });

  test("the baseline is never acted on: opened on A while herdr is on B, a send, unpin, a mode change or Alt+. stay on A", () => {
    const r = rig("idle", "A");
    r.f.focus(claude("B"));
    r.w.text = "hello";
    r.f.composerChanged();
    r.w.text = "";
    r.f.composerChanged();
    r.f.sendEnded();
    r.f.togglePin();
    r.f.togglePin();
    r.w.mode = "auto";
    r.f.modeChanged("auto");
    expect(r.f.followNow()).toBe("nothing");
    r.clock.advance(5000);
    expect(r.log.filter((l) => l.startsWith("switch") || l.startsWith("chip"))).toEqual([]);
    expect(r.w.current).toBe("A");
    expect(r.f.target()).toBeNull();
    // A repeat of the baseline (a stream reconnect) is still not a change; a real move is.
    r.f.focus(claude("B"));
    r.clock.advance(500);
    expect(r.w.current).toBe("A");
    r.f.focus(claude("C"));
    r.clock.advance(150);
    expect(r.w.current).toBe("C");
  });

  test("the baseline pane's transcript turning up is not a change either", () => {
    const r = rig("auto", "A");
    r.f.focus(claude("B", { transcript: false }));
    r.f.focus(claude("B", { transcript: true }));
    r.clock.advance(500);
    expect(r.log).toEqual([]);
  });

  test("a Claude pane whose transcript was not found is ignored until the server reports the transcript", () => {
    const r = rig("auto", "A");
    r.f.focus(claude("A"));
    r.f.focus(claude("B", { transcript: false }));
    r.clock.advance(500);
    expect(r.log).toEqual([]);
    expect(r.f.followNow()).toBe("nothing");
    r.f.focus(claude("B", { transcript: true }));
    r.clock.advance(150);
    expect(r.log).toEqual(["switch B"]);
  });

  test("attachments pending: Alt+. or the chip first asks (Discard N), the second press switches", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.attachments = 2;
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["chip w1:p2"]);
    expect(r.f.followNow()).toBe("confirm");
    expect(r.log.at(-1)).toBe("chip w1:p2 discard 2");
    expect(r.w.current).toBe("w1:p1");
    expect(r.f.followNow()).toBe("switched");
    expect(r.w.current).toBe("w1:p2");
  });

  test("the discard confirmation is dropped when the attachments change or herdr moves", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.attachments = 1;
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.f.followNow()).toBe("confirm");
    r.w.attachments = 2;
    r.f.composerChanged();
    expect(r.log.at(-1)).toBe("chip w1:p2");
    expect(r.f.followNow()).toBe("confirm");
    r.f.focus(claude("w1:p3"));
    r.clock.advance(150);
    expect(r.log.at(-1)).toBe("chip w1:p3");
    expect(r.f.followNow()).toBe("confirm");
    expect(r.w.current).toBe("w1:p1");
  });

  test("the chip goes when herdr moves to a pane that is not Claude, or back to the pane shown", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "x";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.f.focus(shell("w7:p1"));
    r.clock.advance(150);
    expect(r.chip()).toBeNull();
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.f.focus(claude("w1:p1"));
    r.clock.advance(150);
    expect(r.chip()).toBeNull();
  });

  test("auto with text: switches (the per-pane draft keeps the text)", () => {
    const r = rig("auto");
    r.f.focus(claude("w1:p1"));
    r.w.text = "draft";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["switch w1:p2"]);
  });

  test("never during a send: the switch happens when the send ends", () => {
    for (const mode of ["auto", "idle"] as FollowMode[]) {
      const r = rig(mode);
      r.f.focus(claude("w1:p1"));
      r.w.sending = true;
      r.f.focus(claude("w1:p2"));
      r.clock.advance(1000);
      expect(r.log, mode).toEqual([]);
      r.w.sending = false;
      r.f.sendEnded();
      expect(r.log, mode).toEqual(["switch w1:p2"]);
    }
  });

  test("a manual switch pins: herdr is no longer followed, the chip goes, a pending switch is dropped", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.f.focus(claude("w1:p2"));
    r.f.manualSwitch(); // within the debounce
    r.w.current = "w1:p5";
    r.clock.advance(500);
    expect(r.log).toEqual(["pinned"]);
    r.f.focus(claude("w1:p3"));
    r.clock.advance(150);
    expect(r.log).toEqual(["pinned"]);
    expect(r.f.pinned()).toBe(true);
  });

  test("a manual switch while the chip waits: emptying the composer later does not switch", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "x";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.f.manualSwitch();
    r.w.current = "w1:p7";
    r.w.text = "";
    r.f.composerChanged();
    r.f.sendEnded();
    expect(r.log).toEqual(["chip w1:p2", "chip off", "pinned"]);
  });

  test("unpinning (the pin button, Ctrl+Shift+L) catches up with herdr at once", () => {
    const r = rig("auto");
    r.f.focus(claude("w1:p1"));
    r.f.manualSwitch();
    r.f.focus(claude("w1:p4"));
    r.clock.advance(150);
    expect(r.log).toEqual(["pinned"]);
    r.f.togglePin();
    expect(r.log).toEqual(["pinned", "following", "switch w1:p4"]);
    r.f.togglePin();
    expect(r.f.pinned()).toBe(true);
  });

  test("off: a manual switch does not pin, and nothing is followed", () => {
    const r = rig("off");
    r.f.focus(claude("w1:p1"));
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.f.manualSwitch();
    expect(r.log).toEqual([]);
  });

  test("followNow (the chip, Alt+.): switches whatever the composer holds, and unpins", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "x";
    r.f.manualSwitch();
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.f.followNow()).toBe("switched");
    expect(r.log).toEqual(["pinned", "following", "switch w1:p2"]);
    expect(r.f.followNow()).toBe("here");
  });

  test("followNow does nothing during a send, on a pane that is not Claude, on another machine's, or when off", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.f.focus(claude("w1:p2"));
    r.w.sending = true;
    expect(r.f.followNow()).toBe("nothing");
    r.w.sending = false;
    r.f.focus(shell("w7:p1"));
    expect(r.f.followNow()).toBe("nothing");
    r.f.focus(claude("w1:p1A", { remote: true }));
    expect(r.f.followNow()).toBe("nothing");
    r.w.mode = "off";
    expect(r.f.followNow()).toBe("nothing");
    expect(r.log.filter((l) => l.startsWith("switch"))).toEqual([]);
  });

  test("another machine's pane: the note once per pane, the conversation stays", () => {
    const r = rig("auto");
    r.f.focus(claude("w1:p1"));
    r.f.focus(claude("w1:p1A", { remote: true }));
    r.clock.advance(150);
    r.f.composerChanged();
    r.f.sendEnded();
    expect(r.log).toEqual(["remote w1:p1A"]);
    expect(r.w.current).toBe("w1:p1");
  });

  test("turning the setting off forgets herdr; on again, the first focus is a new starting point", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.f.manualSwitch();
    r.w.mode = "off";
    r.f.modeChanged("off");
    expect(r.f.pinned()).toBe(false);
    expect(r.f.target()).toBeNull();
    r.w.mode = "idle";
    r.f.modeChanged("idle");
    r.f.focus(claude("w1:p6"));
    r.clock.advance(150);
    expect(r.log.filter((l) => l.startsWith("switch"))).toEqual([]);
    r.f.focus(claude("w1:p7"));
    r.clock.advance(150);
    expect(r.log.at(-1)).toBe("switch w1:p7");
  });

  test("the pane shown is gone: a pinned window is unpinned and catches up with herdr; off does nothing", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.f.manualSwitch();
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    expect(r.log).toEqual(["pinned"]);
    r.f.paneGone();
    expect(r.log).toEqual(["pinned", "following", "switch w1:p2"]);

    const q = rig("idle");
    q.f.focus(claude("w1:p1"));
    q.f.manualSwitch();
    q.f.paneGone(); // herdr has not moved: unpinned, nothing to switch to yet
    expect(q.f.pinned()).toBe(false);
    q.f.focus(claude("w1:p3"));
    q.clock.advance(150);
    expect(q.log.at(-1)).toBe("switch w1:p3");

    const o = rig("off");
    o.f.paneGone();
    expect(o.log).toEqual([]);
  });

  test("idle to auto with the chip shown switches at once", () => {
    const r = rig("idle");
    r.f.focus(claude("w1:p1"));
    r.w.text = "x";
    r.f.focus(claude("w1:p2"));
    r.clock.advance(150);
    r.w.mode = "auto";
    r.f.modeChanged("auto");
    expect(r.log.at(-1)).toBe("switch w1:p2");
  });
});
