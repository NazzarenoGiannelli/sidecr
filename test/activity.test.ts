import { describe, expect, test } from "bun:test";
import { activityParts, elapsedNow, formatElapsed, formatTokens, type Activity } from "../ui/activity";

describe("formatElapsed", () => {
  test("seconds only under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12)).toBe("12s");
    expect(formatElapsed(59)).toBe("59s");
  });
  test("minutes and seconds", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(104)).toBe("1m 44s");
    expect(formatElapsed(3599)).toBe("59m 59s");
  });
  test("hours, minutes and seconds", () => {
    expect(formatElapsed(3600)).toBe("1h 0m 0s");
    expect(formatElapsed(3723)).toBe("1h 2m 3s");
  });
  test("fractions are floored, never rounded up", () => {
    expect(formatElapsed(11.99)).toBe("11s");
    expect(formatElapsed(59.999)).toBe("59s");
  });
  test("negative and non-finite values give 0s", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(NaN)).toBe("0s");
    expect(formatElapsed(Infinity)).toBe("0s");
  });
});

describe("formatTokens", () => {
  test("small counts are plain", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999)).toBe("999");
  });
  test("one decimal under 10 in each unit", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(9000)).toBe("9.0k");
    expect(formatTokens(9400)).toBe("9.4k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
  test("whole numbers from 10 up", () => {
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(999_000)).toBe("999k");
    expect(formatTokens(12_000_000)).toBe("12M");
  });
  test("a value that rounds up to the next step is shown in that step", () => {
    expect(formatTokens(9960)).toBe("10k");
    expect(formatTokens(999_900)).toBe("1.0M");
  });
  test("negative and non-finite values give 0", () => {
    expect(formatTokens(-3)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });
});

const HOUR = 3600_000;

describe("elapsedNow", () => {
  test("elapsedSec grows with the time since the payload arrived", () => {
    const a: Activity = { source: "screen", elapsedSec: 10 };
    expect(elapsedNow(a, 1000, 1000)).toBe(10);
    expect(elapsedNow(a, 1000, 4500)).toBe(13.5);
  });
  test("elapsedSec wins over startedAt", () => {
    const a: Activity = { source: "screen", elapsedSec: 10, startedAt: new Date(0).toISOString() };
    expect(elapsedNow(a, 5000, 5000)).toBe(10);
  });
  test("without elapsedSec it counts from startedAt", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const a: Activity = { source: "transcript", startedAt: "2026-10-01T11:58:00Z" };
    expect(elapsedNow(a, 0, now)).toBe(120);
  });
  test("an invalid startedAt gives null", () => {
    expect(elapsedNow({ source: "transcript", startedAt: "not a date" }, 0, 1000)).toBeNull();
  });
  test("a startedAt in the future gives null", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(elapsedNow({ source: "transcript", startedAt: "2026-10-01T12:00:05Z" }, 0, now)).toBeNull();
  });
  test("a startedAt more than 24 hours ago gives null", () => {
    const now = Date.parse("2026-10-02T12:00:01Z");
    expect(elapsedNow({ source: "transcript", startedAt: "2026-10-01T12:00:00Z" }, 0, now)).toBeNull();
  });
  test("exactly 24 hours is still shown", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(elapsedNow({ source: "transcript", startedAt: "2026-10-01T12:00:00Z" }, 0, now)).toBe(24 * 3600);
  });
  test("neither elapsedSec nor startedAt gives null", () => {
    expect(elapsedNow({ source: "transcript" }, 0, HOUR)).toBeNull();
  });
  test("a non-numeric elapsedSec falls back to startedAt", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const a = { source: "screen", elapsedSec: "x", startedAt: "2026-10-01T11:59:00Z" } as unknown as Activity;
    expect(elapsedNow(a, 0, now)).toBe(60);
  });
});

describe("activityParts", () => {
  const t0 = 1_000_000;
  test("screen activity: verb, elapsed, detail", () => {
    const a: Activity = { source: "screen", verb: "Cooking", elapsedSec: 104, detail: "thinking" };
    expect(activityParts(a, t0, t0)).toEqual(["Cooking", "1m 44s", "thinking"]);
  });
  test("the verb defaults to Working", () => {
    expect(activityParts({ source: "screen", elapsedSec: 3 }, t0, t0)).toEqual(["Working", "3s"]);
  });
  test("an empty verb or detail counts as missing", () => {
    expect(activityParts({ source: "screen", verb: "  ", elapsedSec: 3, detail: "" }, t0, t0)).toEqual(["Working", "3s"]);
  });
  test("without detail, output tokens are shown", () => {
    const a: Activity = { source: "transcript", startedAt: new Date(t0 - 12_000).toISOString(), tokens: { input: 99999, output: 1234 } };
    expect(activityParts(a, 0, t0)).toEqual(["Working", "12s", "↓ 1.2k tokens"]);
  });
  test("detail wins over tokens", () => {
    const a: Activity = { source: "screen", elapsedSec: 1, detail: "x", tokens: { input: 1, output: 500 } };
    expect(activityParts(a, t0, t0)).toEqual(["Working", "1s", "x"]);
  });
  test("zero output tokens show nothing, and input tokens are never shown", () => {
    const a: Activity = { source: "transcript", tokens: { input: 5000, output: 0 } };
    expect(activityParts(a, 0, t0)).toEqual(["Working"]);
  });
  test("a transcript activity with an old startedAt shows no elapsed", () => {
    const a: Activity = { source: "transcript", startedAt: new Date(t0 - 25 * HOUR).toISOString(), tokens: { input: 0, output: 10 } };
    expect(activityParts(a, 0, t0)).toEqual(["Working", "↓ 10 tokens"]);
  });
});
