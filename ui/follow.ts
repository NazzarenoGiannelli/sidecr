/**
 * Following the pane selected in herdr (setting followFocus). The server pushes a `focus` event when herdr's focused
 * pane changes (src/focus.ts); this decides what the window does with it. decideFollow is the pure rule, createFollower
 * the small state machine around it (the latest focus, the pin, the 150 ms debounce). ui/app.ts only wires it.
 * Pure: no DOM, timers injected.
 */
import type { FocusEvent } from "../src/focus";
import type { Settings } from "../src/settings-schema";
import { createDebouncer } from "./debounce";
import { realTimers, type TimerApi } from "./timers";

export type FollowMode = Settings["followFocus"];
export type FocusTarget = FocusEvent;

/** How long focus events settle before the window acts: quick sidebar navigation must not thrash. */
export const FOLLOW_DEBOUNCE_MS = 150;

/**
 * With the chip shown, how long a composer emptied by editing must stay quiet before the window switches: the user may
 * be rewriting the message, and the next keystrokes must not land in the other conversation. A send switches at once.
 */
export const FOLLOW_QUIET_MS = 1000;

/** The text shown for a pane of another machine. */
export const REMOTE_TEXT = "This agent runs on another machine; its conversation is not available here";

/** A focus event's data, checked field by field; null when it is not one. */
export function parseFocusEvent(raw: unknown): FocusTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.paneId !== "string" || o.paneId === "" || o.paneId.length > 200) return null;
  if (typeof o.isClaude !== "boolean") return null;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    paneId: o.paneId,
    agent: typeof o.agent === "string" ? o.agent : null,
    isClaude: o.isClaude,
    title: str(o.title, o.paneId),
    workspace: str(o.workspace, ""),
    remote: o.remote === true,
    ...(typeof o.transcript === "boolean" ? { transcript: o.transcript } : {}),
    ...(typeof o.machine === "string" && o.machine ? { machine: o.machine } : {}),
  };
}

export interface FollowInputs {
  mode: FollowMode;
  /** A manual switch pinned the window to its pane. */
  pinned: boolean;
  /** The pane the window shows (and sends to). */
  current: string;
  /** herdr's focused pane, as last reported. */
  target: FocusTarget | null;
  composerEmpty: boolean;
  attachments: number;
  /** A message is on its way to the current pane. */
  sending: boolean;
}

export type FollowDecision =
  | { kind: "none" }
  /** Switch to this pane now. */
  | { kind: "switch"; paneId: string }
  /** Offer the switch (the chip) instead of doing it: the composer holds something. */
  | { kind: "suggest"; target: FocusTarget }
  /** A send is in flight: decide again when it ends. */
  | { kind: "wait" }
  /** herdr is on a Claude pane of another machine: say so, stay here. */
  | { kind: "remote"; target: FocusTarget };

/**
 * What to do about herdr's focus. Off or pinned: nothing. A pane that is not Claude: nothing (the last conversation
 * stays, no flicker). Another machine's pane: say so. The pane already shown: nothing. A Claude pane whose transcript
 * was not found: nothing (no switch into a "Transcript not found" screen; the server reports it again once the file
 * appears). During a send: wait. "idle" with text or an attachment in the composer: offer. Otherwise switch. "auto"
 * also offers rather than switching while an attachment is pending (a switch would drop it; drafts are kept per pane,
 * attachments are not).
 */
export function decideFollow(s: FollowInputs): FollowDecision {
  const t = s.target;
  if (s.mode === "off" || s.pinned || !t || !t.isClaude) return { kind: "none" };
  if (t.remote) return { kind: "remote", target: t };
  if (t.paneId === s.current) return { kind: "none" };
  if (t.transcript === false) return { kind: "none" };
  if (s.sending) return { kind: "wait" };
  if (s.attachments > 0) return { kind: "suggest", target: t };
  if (s.mode === "idle" && !s.composerEmpty) return { kind: "suggest", target: t };
  return { kind: "switch", paneId: t.paneId };
}

export interface FollowerDeps {
  /** The window's side of the inputs, read when a decision is made. */
  state(): Pick<FollowInputs, "mode" | "current" | "composerEmpty" | "attachments" | "sending">;
  /** Switch to this pane exactly as the switcher does, marked as a follow (the header flashes). */
  switchTo(target: FocusTarget): void;
  /**
   * Show the chip for this pane, or hide it (null). `discard` > 0: the switch would drop that many pending
   * attachments, and the chip asks for a second press ("Discard N attachments and switch").
   */
  suggest(target: FocusTarget | null, discard: number): void;
  /** herdr is on another machine's pane. */
  remote(target: FocusTarget): void;
  /** The pin changed (the header button redraws). */
  pinChanged(pinned: boolean): void;
  timers?: TimerApi;
  debounceMs?: number;
  quietMs?: number;
}

/** Two focus reports of the same thing (a stream reconnect sends the last one again). */
const sameFocus = (a: FocusTarget, b: FocusTarget): boolean =>
  a.paneId === b.paneId && a.isClaude === b.isClaude && a.remote === b.remote && a.transcript === b.transcript;

export function createFollower(deps: FollowerDeps) {
  const timers = deps.timers ?? realTimers;
  // The first focus a window hears is where herdr already is when it opens: the window keeps the pane it was opened
  // on (as before this feature) and follows from the next change. That baseline is only remembered (`last`, to tell a
  // repeat from a change); decisions get no target (`target` stays null) until herdr really moves.
  let last: FocusTarget | null = null;
  let target: FocusTarget | null = null;
  let pinned = false;
  let shownRemote: string | null = null;
  let chip: string | null = null;
  // The chip was pressed once while attachments were pending: the next press switches (and drops them).
  let armed: { paneId: string; count: number } | null = null;

  const setChip = (t: FocusTarget | null, discard = 0) => {
    const id = t ? `${t.paneId}|${t.title}|${t.workspace}|${discard}` : null;
    if (id === chip) return;
    chip = id;
    deps.suggest(t, discard);
  };
  const armedFor = (t: FocusTarget | null, count: number): boolean =>
    t !== null && armed !== null && armed.paneId === t.paneId && armed.count === count && count > 0;

  function evaluate(): void {
    quiet.cancel();
    const s = deps.state();
    const d = decideFollow({ ...s, pinned, target });
    if (d.kind !== "remote") shownRemote = null;
    if (d.kind !== "suggest" || !armedFor(d.target, s.attachments)) armed = null;
    switch (d.kind) {
      case "switch":
        setChip(null);
        deps.switchTo(target!);
        return;
      case "suggest":
        setChip(d.target, armed ? s.attachments : 0);
        return;
      case "remote":
        setChip(null);
        if (shownRemote !== d.target.paneId) {
          shownRemote = d.target.paneId;
          deps.remote(d.target);
        }
        return;
      case "wait":
        return; // sendEnded() decides again
      case "none":
        setChip(null);
        return;
    }
  }

  const debounced = createDebouncer(() => evaluate(), deps.debounceMs ?? FOLLOW_DEBOUNCE_MS, timers);
  const quiet = createDebouncer(() => evaluate(), deps.quietMs ?? FOLLOW_QUIET_MS, timers);

  const setPinned = (v: boolean) => {
    if (pinned === v) return;
    pinned = v;
    deps.pinChanged(v);
  };

  return {
    /** A focus event from the server. */
    focus(t: FocusTarget): void {
      if (last === null) {
        last = t;
        return;
      }
      const repeat = sameFocus(last, t) || (target === null && last.paneId === t.paneId);
      last = t;
      if (repeat) {
        // Nothing happened in herdr (or only the baseline pane's details changed): keep the details fresh. (A
        // followed pane's transcript turning up is not a repeat: sameFocus compares the transcript flag.)
        if (target !== null && target.paneId === t.paneId) target = t;
        return;
      }
      target = t;
      debounced.call();
    },
    /**
     * The composer or the tray changed. With the chip shown, a composer emptied by editing switches only after
     * FOLLOW_QUIET_MS without another change; typing again cancels the wait (the chip stays).
     */
    composerChanged(): void {
      if (chip === null) return;
      const s = deps.state();
      if (!s.composerEmpty || s.attachments > 0) {
        quiet.cancel();
        if (armed && !armedFor(target, s.attachments)) evaluate(); // the attachments changed: back to the plain chip
        return;
      }
      quiet.call();
    },
    /** A send ended (sent or failed): a switch that waited for it is decided now. */
    /**
     * The pane shown is gone (closed in herdr). A pinned window would otherwise ignore every later selection and stay
     * dead: it is unpinned, and catches up at once if herdr is already on another Claude pane.
     */
    paneGone(): void {
      if (deps.state().mode === "off") return;
      setPinned(false);
      evaluate();
    },
    sendEnded(): void {
      evaluate();
    },
    /** The user picked a pane (switcher, Alt+Up/Down, Alt+1..9): following pauses until unpinned. */
    manualSwitch(): void {
      debounced.cancel();
      quiet.cancel();
      armed = null;
      setChip(null);
      if (deps.state().mode !== "off") setPinned(true);
    },
    /** The pin button or Ctrl+Shift+L. Unpinning catches up with herdr at once. */
    togglePin(): void {
      setPinned(!pinned);
      if (pinned) {
        quiet.cancel();
        armed = null;
        setChip(null);
      } else evaluate();
    },
    /**
     * The chip or Alt+.: go to herdr's pane now, whatever the composer holds, and follow from here. With attachments
     * pending the first press only arms the chip ("Discard N attachments and switch"); the second one switches.
     */
    followNow(): "switched" | "here" | "confirm" | "nothing" {
      setPinned(false);
      debounced.cancel();
      quiet.cancel();
      const s = deps.state();
      const t = target;
      if (s.mode === "off" || !t || !t.isClaude || t.remote || s.sending || (t.transcript === false && t.paneId !== s.current)) {
        evaluate();
        return "nothing";
      }
      if (t.paneId === s.current) {
        armed = null;
        setChip(null);
        return "here";
      }
      if (s.attachments > 0 && !armedFor(t, s.attachments)) {
        armed = { paneId: t.paneId, count: s.attachments };
        setChip(t, s.attachments);
        return "confirm";
      }
      armed = null;
      setChip(null);
      deps.switchTo(t);
      return "switched";
    },
    /** The setting changed. Off forgets herdr's focus: turning it back on starts from where herdr is then. */
    modeChanged(mode: FollowMode): void {
      if (mode === "off") {
        debounced.cancel();
        quiet.cancel();
        target = null;
        last = null;
        armed = null;
        setPinned(false);
        setChip(null);
        return;
      }
      evaluate();
    },
    pinned: (): boolean => pinned,
    /** herdr's focus once it has moved since the window opened (null before that, and while following is off). */
    target: (): FocusTarget | null => target,
  };
}
