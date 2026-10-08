import { describe, expect, test } from "bun:test";
import { createStatusWatch, notificationTitle, shouldNotify } from "../ui/notify";

describe("shouldNotify", () => {
  test("working to done or idle, window not focused: finished", () => {
    expect(shouldNotify("working", "done", false, "granted")).toBe("finished");
    expect(shouldNotify("working", "idle", false, "granted")).toBe("finished");
  });
  test("anything to blocked, window not focused: needs-you", () => {
    expect(shouldNotify("working", "blocked", false, "granted")).toBe("needs-you");
    expect(shouldNotify("idle", "blocked", false, "granted")).toBe("needs-you");
    expect(shouldNotify(null, "blocked", false, "granted")).toBe("needs-you");
  });
  test("staying blocked does not notify again", () => {
    expect(shouldNotify("blocked", "blocked", false, "granted")).toBeNull();
  });
  test("a focused window never notifies", () => {
    expect(shouldNotify("working", "done", true, "granted")).toBeNull();
    expect(shouldNotify("working", "blocked", true, "granted")).toBeNull();
  });
  test("without permission nothing is sent", () => {
    for (const p of ["default", "denied", "unsupported"]) {
      expect(shouldNotify("working", "done", false, p)).toBeNull();
      expect(shouldNotify("working", "blocked", false, p)).toBeNull();
    }
  });
  test("finished needs the previous status to be working", () => {
    expect(shouldNotify("idle", "done", false, "granted")).toBeNull();
    expect(shouldNotify("done", "idle", false, "granted")).toBeNull();
    expect(shouldNotify("blocked", "idle", false, "granted")).toBeNull();
    expect(shouldNotify(null, "done", false, "granted")).toBeNull();
    expect(shouldNotify(null, "idle", false, "granted")).toBeNull();
  });
  test("other transitions are silent", () => {
    expect(shouldNotify("idle", "working", false, "granted")).toBeNull();
    expect(shouldNotify("working", "working", false, "granted")).toBeNull();
    expect(shouldNotify("working", "unknown", false, "granted")).toBeNull();
  });
});

describe("notificationTitle", () => {
  test("one title per kind", () => {
    expect(notificationTitle("finished")).toBe("Claude finished");
    expect(notificationTitle("needs-you")).toBe("Claude needs you");
  });
});

describe("createStatusWatch", () => {
  test("the first status seen has no previous one", () => {
    const w = createStatusWatch();
    expect(w.next("working")).toBeNull();
  });
  test("each call returns the status before it", () => {
    const w = createStatusWatch();
    w.next("idle");
    expect(w.next("working")).toBe("idle");
    expect(w.next("done")).toBe("working");
  });
  test("reset forgets the previous status, so a pane switch cannot look like a transition", () => {
    const w = createStatusWatch();
    w.next("working");
    w.reset();
    expect(w.next("idle")).toBeNull();
    expect(shouldNotify(w.next("idle"), "idle", false, "granted")).toBeNull();
  });
});

describe("the notifyOnFinish setting", () => {
  test("off: no finished notification, needs-you still notifies", () => {
    expect(shouldNotify("working", "idle", false, "granted", false)).toBeNull();
    expect(shouldNotify("working", "done", false, "granted", false)).toBeNull();
    expect(shouldNotify("idle", "blocked", false, "granted", false)).toBe("needs-you");
  });
  test("on (the default): unchanged", () => {
    expect(shouldNotify("working", "idle", false, "granted", true)).toBe("finished");
    expect(shouldNotify("working", "idle", false, "granted")).toBe("finished");
  });
});
