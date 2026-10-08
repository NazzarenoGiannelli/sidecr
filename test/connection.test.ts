import { describe, expect, test } from "bun:test";
import { createConnectionTracker } from "../ui/connection";

describe("createConnectionTracker", () => {
  test("a closed stream is a disconnect at once", () => {
    expect(createConnectionTracker().error(true)).toBe("disconnected");
  });
  test("three errors in a row without a message are a disconnect", () => {
    const t = createConnectionTracker();
    expect(t.error(false)).toBe("retry");
    expect(t.error(false)).toBe("retry");
    expect(t.error(false)).toBe("disconnected");
  });
  test("a message resets the count", () => {
    const t = createConnectionTracker();
    t.error(false);
    t.error(false);
    t.message();
    expect(t.error(false)).toBe("retry");
    expect(t.error(false)).toBe("retry");
    expect(t.error(false)).toBe("disconnected");
  });
  test("reset clears the count for a new stream", () => {
    const t = createConnectionTracker();
    t.error(false);
    t.error(false);
    t.reset();
    expect(t.error(false)).toBe("retry");
  });
});
