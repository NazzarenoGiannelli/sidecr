import { describe, expect, test } from "bun:test";
import { defaultSettings, type Settings } from "../src/settings-schema";
import { createSettingsClient } from "../ui/settings-client";
import type { TimerApi } from "../ui/timers";

function manualTimers() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const timers: TimerApi = {
    set: (fn) => {
      const id = next++;
      queue.set(id, fn);
      return id;
    },
    clear: (h) => void queue.delete(h as number),
  };
  return { timers, fire: () => { const fns = [...queue.values()]; queue.clear(); fns.forEach((f) => f()); }, pending: () => queue.size };
}

function harness(opts: { fail?: boolean; hold?: boolean } = {}) {
  const t = manualTimers();
  const puts: Partial<Settings>[] = [];
  const keepalives: boolean[] = [];
  const applied: { next: Settings; prev: Settings | null }[] = [];
  let server = defaultSettings();
  const held: (() => void)[] = [];
  let failures = 0;
  const client = createSettingsClient({
    put: (patch, putOpts) => {
      puts.push(patch);
      keepalives.push(putOpts?.keepalive === true);
      if (opts.fail) return Promise.resolve(null);
      server = { ...server, ...patch };
      const answer = { ...server };
      if (opts.hold) return new Promise((r) => held.push(() => r(answer)));
      return Promise.resolve(answer);
    },
    apply: (next, prev) => applied.push({ next, prev }),
    failed: () => void failures++,
    timers: t.timers,
  });
  return { client, puts, keepalives, applied, t, release: () => held.splice(0).forEach((f) => f()), failures: () => failures, setServer: (s: Settings) => { server = s; } };
}

describe("settings client", () => {
  test("load applies once; the same settings again apply nothing", () => {
    const h = harness();
    h.client.load(defaultSettings());
    h.client.load(defaultSettings());
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.prev).toBeNull();
  });

  test("a change applies at once and is saved at once", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    await h.client.change("textSize", "large");
    expect(h.applied.at(-1)!.next.textSize).toBe("large");
    expect(h.applied.at(-1)!.prev!.textSize).toBe("medium");
    expect(h.puts).toEqual([{ textSize: "large" }]);
  });

  test("an invalid value is dropped before anything happens", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    await h.client.change("effect", "plasma");
    expect(h.puts).toEqual([]);
    expect(h.applied).toHaveLength(1);
  });

  test("the slider is debounced: one save with the last value, applied live meanwhile", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    for (const v of [10, 20, 30]) void h.client.change("strength", v, { debounce: true });
    expect(h.applied.map((a) => a.next.strength)).toEqual([60, 10, 20, 30]);
    expect(h.puts).toEqual([]);
    h.t.fire();
    await Promise.resolve();
    expect(h.puts).toEqual([{ strength: 30 }]);
  });

  test("flush sends a debounced change right away", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    void h.client.change("strength", 5, { debounce: true });
    await h.client.flush();
    expect(h.puts).toEqual([{ strength: 5 }]);
    expect(h.t.pending()).toBe(0);
  });

  test("on unload, a pending slider save goes out at once as a keepalive request (survives a fast close)", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    void h.client.change("strength", 7, { debounce: true });
    await h.client.flush({ keepalive: true });
    expect(h.puts).toEqual([{ strength: 7 }]);
    expect(h.keepalives).toEqual([true]);
    await h.client.flush({ keepalive: true }); // nothing pending: nothing sent
    expect(h.puts).toHaveLength(1);
    await h.client.change("textSize", "small"); // an ordinary save is not keepalive
    expect(h.keepalives).toEqual([true, false]);
  });

  test("a pushed event is ignored while a local change is pending, applied otherwise", async () => {
    const h = harness({ hold: true });
    h.client.load(defaultSettings());
    void h.client.change("strength", 40, { debounce: true });
    h.client.pushed({ ...defaultSettings(), strength: 99 }); // an older value must not make the slider jump back
    expect(h.client.current().strength).toBe(40);
    h.t.fire();
    expect(h.client.busy()).toBe(true);
    h.client.pushed({ ...defaultSettings(), strength: 99 });
    expect(h.client.current().strength).toBe(40);
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.client.busy()).toBe(false);
    h.client.pushed({ ...defaultSettings(), strength: 70, alwaysOnTop: false }); // another window changed it
    expect(h.client.current()).toEqual({ ...defaultSettings(), strength: 70, alwaysOnTop: false });
  });

  test("the server's answer wins when nothing newer is pending", async () => {
    const h = harness();
    h.client.load(defaultSettings());
    h.setServer({ ...defaultSettings(), sendKey: "ctrl-enter" }); // changed elsewhere meanwhile
    await h.client.change("textSize", "small");
    expect(h.client.current()).toEqual({ ...defaultSettings(), sendKey: "ctrl-enter", textSize: "small" });
  });

  test("a failed save is reported and the local value stays", async () => {
    const h = harness({ fail: true });
    h.client.load(defaultSettings());
    await h.client.change("alwaysOnTop", false);
    expect(h.failures()).toBe(1);
    expect(h.client.current().alwaysOnTop).toBe(false);
  });

  test("reset sends every default in one save", async () => {
    const h = harness();
    h.client.load({ ...defaultSettings(), strength: 1, textSize: "large" });
    await h.client.reset();
    expect(h.puts).toEqual([defaultSettings()]);
    expect(h.client.current()).toEqual(defaultSettings());
  });

  test("load while a change is pending is ignored", () => {
    const h = harness();
    h.client.load(defaultSettings());
    void h.client.change("strength", 12, { debounce: true });
    h.client.load(defaultSettings());
    expect(h.client.current().strength).toBe(12);
  });
});
