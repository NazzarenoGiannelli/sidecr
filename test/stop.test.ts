import { describe, expect, test } from "bun:test";
import { createStopper } from "../ui/stop";

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: unknown) => void pending.delete(id as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

function setup(post: (pane: string) => Promise<{ ok: boolean; deduped?: boolean }>) {
  const f = fakeTimers();
  const log: string[] = [];
  const disabled: boolean[] = [];
  const stopper = createStopper({
    post: (pane) => {
      log.push(`post ${pane}`);
      return post(pane);
    },
    getPane: () => "w1:p1",
    setDisabled: (d) => disabled.push(d),
    showError: (t) => log.push(`error ${t}`),
    timers: f.timers,
  });
  return { stopper, f, log, disabled };
}

describe("createStopper", () => {
  test("a click posts the current pane and disables the button", async () => {
    const s = setup(async () => ({ ok: true }));
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1"]);
    expect(s.disabled).toEqual([true]);
  });
  test("the button comes back after 1500 ms, not before", async () => {
    const s = setup(async () => ({ ok: true }));
    await s.stopper.click();
    s.f.advance(1499);
    expect(s.disabled).toEqual([true]);
    s.f.advance(1);
    expect(s.disabled).toEqual([true, false]);
  });
  test("a second click during the cooldown posts nothing", async () => {
    const s = setup(async () => ({ ok: true }));
    await s.stopper.click();
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1"]);
  });
  test("after the cooldown a click posts again", async () => {
    const s = setup(async () => ({ ok: true }));
    await s.stopper.click();
    s.f.advance(1500);
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1", "post w1:p1"]);
  });
  test("deduped counts as success", async () => {
    const s = setup(async () => ({ ok: true, deduped: true }));
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1"]);
  });
  test("a failure shows the error text and still waits out the cooldown", async () => {
    const s = setup(async () => {
      throw new Error("Pane is not working");
    });
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1", "error Pane is not working"]);
    expect(s.disabled).toEqual([true]);
    s.f.advance(1500);
    expect(s.disabled).toEqual([true, false]);
  });
  test("a thrown non-Error is shown as text", async () => {
    const s = setup(async () => {
      throw "boom";
    });
    await s.stopper.click();
    expect(s.log).toEqual(["post w1:p1", "error boom"]);
  });
});
