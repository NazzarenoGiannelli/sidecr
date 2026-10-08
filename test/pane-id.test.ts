import { describe, expect, test } from "bun:test";
import { resolvePaneId } from "../src/pane-id";

const ctx = (o: object) => JSON.stringify(o);

describe("resolvePaneId", () => {
  test("HERDR_PANE_ID wins over the plugin context", () => {
    expect(
      resolvePaneId({ HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONTEXT_JSON: ctx({ focused_pane_id: "w9:p9" }) }),
    ).toBe("w1:p1");
  });
  test("falls back to focused_pane_id from the plugin context", () => {
    expect(resolvePaneId({ HERDR_PLUGIN_CONTEXT_JSON: ctx({ focused_pane_id: "w2:p3", workspace_id: "w2" }) })).toBe("w2:p3");
  });
  test("an empty HERDR_PANE_ID counts as unset", () => {
    expect(resolvePaneId({ HERDR_PANE_ID: "", HERDR_PLUGIN_CONTEXT_JSON: ctx({ focused_pane_id: "w2:p3" }) })).toBe("w2:p3");
  });
  test("invalid JSON in the context is tolerated", () => {
    expect(resolvePaneId({ HERDR_PLUGIN_CONTEXT_JSON: "{nope" })).toBeNull();
  });
  test("a context without a usable focused_pane_id gives null", () => {
    expect(resolvePaneId({ HERDR_PLUGIN_CONTEXT_JSON: ctx({ workspace_id: "w1" }) })).toBeNull();
    expect(resolvePaneId({ HERDR_PLUGIN_CONTEXT_JSON: ctx({ focused_pane_id: 5 }) })).toBeNull();
    expect(resolvePaneId({ HERDR_PLUGIN_CONTEXT_JSON: "null" })).toBeNull();
  });
  test("neither source gives null", () => {
    expect(resolvePaneId({})).toBeNull();
  });
});
