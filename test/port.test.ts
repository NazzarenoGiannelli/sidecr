import { describe, expect, test } from "bun:test";
import { DEFAULT_PORT, preferredPortFrom, startOnPreferredPort } from "../src/port";

describe("startOnPreferredPort", () => {
  test("uses the preferred port when it starts", () => {
    const tried: number[] = [];
    const out = startOnPreferredPort((p) => { tried.push(p); return `server on ${p}`; }, 47631);
    expect(out).toBe("server on 47631");
    expect(tried).toEqual([47631]);
  });

  test("falls back to port 0 when the preferred port throws", () => {
    const tried: number[] = [];
    const out = startOnPreferredPort((p) => {
      tried.push(p);
      if (p !== 0) throw new Error("EADDRINUSE");
      return "random";
    }, 47631);
    expect(out).toBe("random");
    expect(tried).toEqual([47631, 0]);
  });

  test("an error from the fallback is not swallowed", () => {
    expect(() => startOnPreferredPort(() => { throw new Error("no sockets"); }, 47631)).toThrow("no sockets");
  });

  test.each([0, -1, 80, 1023, 65536, 70000, 1.5, Number.NaN, Infinity])("an invalid preferred port (%p) goes straight to 0", (bad) => {
    const tried: number[] = [];
    startOnPreferredPort((p) => { tried.push(p); return p; }, bad);
    expect(tried).toEqual([0]);
  });

  test("the range edges are valid", () => {
    for (const edge of [1024, 65535]) {
      const tried: number[] = [];
      startOnPreferredPort((p) => { tried.push(p); return p; }, edge);
      expect(tried).toEqual([edge]);
    }
  });
});

describe("with a real Bun.serve", () => {
  test("a taken preferred port falls back to a free one", () => {
    const first = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("a") });
    let second: ReturnType<typeof Bun.serve> | undefined;
    try {
      const taken = Number(first.port);
      second = startOnPreferredPort((port) => Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("b") }), taken);
      expect(Number(second.port)).not.toBe(taken);
      expect(Number(second.port)).toBeGreaterThan(0);
    } finally {
      second?.stop(true);
      first.stop(true);
    }
  });
});

describe("preferredPortFrom", () => {
  test("a valid value wins", () => {
    expect(preferredPortFrom("50000")).toBe(50000);
    expect(preferredPortFrom(" 50000 ")).toBe(50000);
  });

  test("unset, empty, or invalid values give the default", () => {
    for (const raw of [undefined, "", "abc", "0", "80", "99999", "1.5", "-4"]) expect(preferredPortFrom(raw)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(47631);
  });
});
