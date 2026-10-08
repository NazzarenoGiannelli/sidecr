import { describe, expect, test } from "bun:test";
import { PING_MS, byeBlobType, createWindowSession, newWindowId, windowEventBody } from "../ui/window-session";

const ID = /^[0-9a-f]{32}$/;
const SERVER_ID = /^[A-Za-z0-9-]{1,64}$/;

describe("newWindowId", () => {
  test("uses randomUUID when there is one", () => {
    const id = newWindowId({ randomUUID: () => "3f2b9c1e-5d4a-4e8b-9a3c-0123456789ab" });
    expect(id).toBe("3f2b9c1e-5d4a-4e8b-9a3c-0123456789ab");
    expect(SERVER_ID.test(id)).toBe(true);
  });
  test("without randomUUID it is 32 hex characters from getRandomValues", () => {
    let n = 0;
    const id = newWindowId({ getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = n++ * 17; return a; } });
    expect(id).toMatch(ID);
  });
  test("without any crypto it is still 32 hex characters, and two calls differ", () => {
    const a = newWindowId(undefined);
    const b = newWindowId(undefined);
    expect(a).toMatch(ID);
    expect(b).toMatch(ID);
    expect(a).not.toBe(b);
  });
  test("a randomUUID that returns something the server would refuse is replaced", () => {
    expect(newWindowId({ randomUUID: () => "not valid!" })).toMatch(ID);
  });
});

describe("window session", () => {
  function setup() {
    const sent: string[] = [];
    let next = 1;
    const pending = new Map<number, { at: number; fn: () => void }>();
    let now = 0;
    const timers = {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: unknown) => void pending.delete(id as number),
    };
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    };
    const session = createWindowSession({ id: "w-1", send: (event) => { sent.push(event); }, timers });
    return { sent, advance, session, pendingCount: () => pending.size };
  }

  test("start sends hello once, then a ping every 3000 ms", () => {
    expect(PING_MS).toBe(3000);
    const { sent, advance, session } = setup();
    session.start();
    expect(sent).toEqual(["hello"]);
    advance(2999);
    expect(sent).toEqual(["hello"]);
    advance(1);
    expect(sent).toEqual(["hello", "ping"]);
    advance(6000);
    expect(sent).toEqual(["hello", "ping", "ping", "ping"]);
  });

  test("stop ends the pings", () => {
    const { sent, advance, session, pendingCount } = setup();
    session.start();
    advance(3000);
    session.stop();
    expect(pendingCount()).toBe(0);
    advance(30_000);
    expect(sent).toEqual(["hello", "ping"]);
  });

  test("a second start does not double the pings", () => {
    const { sent, advance, session } = setup();
    session.start();
    session.start();
    advance(3000);
    expect(sent).toEqual(["hello", "ping"]);
  });

  test("a throwing ping is swallowed and the next one is scheduled", () => {
    const calls: string[] = [];
    const queue: (() => void)[] = [];
    const s = createWindowSession({
      id: "w-3",
      send: (e) => { calls.push(e); if (e === "ping") throw new Error("offline"); },
      timers: { set: (fn) => { queue.push(fn); return queue.length; }, clear: () => {} },
    });
    s.start();
    queue.shift()!();
    queue.shift()!();
    expect(calls).toEqual(["hello", "ping", "ping"]);
  });

  describe("a close request in the answer", () => {
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    function withAnswers(answers: Array<{ close?: boolean } | void | Error>) {
      const closed: number[] = [];
      const queue: (() => void)[] = [];
      let i = 0;
      const s = createWindowSession({
        id: "w-9",
        send: () => {
          const a = answers[Math.min(i++, answers.length - 1)];
          return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
        },
        onClose: () => { closed.push(1); },
        timers: { set: (fn) => { queue.push(fn); return queue.length; }, clear: () => {} },
      });
      return { s, closed, tick: async () => { queue.shift()?.(); await flush(); } };
    }

    test("close: true in the answer to a ping calls onClose", async () => {
      const { s, closed, tick } = withAnswers([{ close: false }, { close: false }, { close: true }]);
      s.start();
      await flush();
      expect(closed).toEqual([]);
      await tick();
      expect(closed).toEqual([]);
      await tick();
      expect(closed).toEqual([1]);
    });

    test("close: true in the answer to the hello also calls onClose", async () => {
      const { s, closed } = withAnswers([{ close: true }]);
      s.start();
      await flush();
      expect(closed).toEqual([1]);
    });

    test("an answer without close, an empty answer and a failed request do nothing, and the pings go on", async () => {
      const { s, closed, tick } = withAnswers([{}, undefined, new Error("offline"), { close: true }]);
      s.start();
      await flush();
      await tick();
      await tick();
      expect(closed).toEqual([]);
      await tick();
      expect(closed).toEqual([1]);
    });

    test("an answer that arrives after stop is ignored", async () => {
      const { s, closed } = withAnswers([{ close: true }]);
      s.start();
      s.stop();
      await flush();
      expect(closed).toEqual([]);
    });
  });

  test("the id is exposed for the stream query and the bye", () => {
    expect(setup().session.id).toBe("w-1");
  });
});

describe("event payload", () => {
  test("the body is the id and the event as JSON, and the beacon type is JSON so the server accepts it", () => {
    expect(JSON.parse(windowEventBody("w-1", "bye"))).toEqual({ id: "w-1", event: "bye" });
    expect(byeBlobType).toBe("application/json");
  });
});
