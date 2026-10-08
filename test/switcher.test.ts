import { describe, expect, test } from "bun:test";
import { filterPanes, type PaneRow } from "../ui/switcher";

const rows: PaneRow[] = [
  { paneId: "w1:p1", title: "morning", workspaceId: "w1", workspace: "notes", agentStatus: "working" },
  { paneId: "w2:p1", title: "BE-infra", workspaceId: "w2", workspace: "Web", agentStatus: "idle" },
  { paneId: "w2:p2", title: "UnitTests", workspaceId: "w2", workspace: "Web", agentStatus: "idle" },
];

test("empty query keeps everything in order", () => {
  expect(filterPanes(rows, "").map((r) => r.paneId)).toEqual(["w1:p1", "w2:p1", "w2:p2"]);
});
test("matches by title, case-insensitive", () => {
  expect(filterPanes(rows, "be-in").map((r) => r.paneId)).toEqual(["w2:p1"]);
});
test("matches by workspace label", () => {
  expect(filterPanes(rows, "web").map((r) => r.paneId)).toEqual(["w2:p1", "w2:p2"]);
});
test("every word must match somewhere in title or workspace label", () => {
  expect(filterPanes(rows, "web tests").map((r) => r.paneId)).toEqual(["w2:p2"]);
});
test("the workspace id is not searched, only the label the user sees", () => {
  expect(filterPanes(rows, "w2")).toEqual([]);
});
test("a row without a workspace label still matches by title", () => {
  const bare: PaneRow[] = [{ paneId: "w3:p1", title: "scratch", workspaceId: "w3", workspace: "", agentStatus: "idle" }];
  expect(filterPanes(bare, "scratch").map((r) => r.paneId)).toEqual(["w3:p1"]);
});
test("no match gives an empty list", () => {
  expect(filterPanes(rows, "zzz")).toEqual([]);
});

describe("paneStep and nthPane (Alt+Up/Down, Alt+1..9)", () => {
  const { nthPane, paneStep } = require("../ui/switcher") as typeof import("../ui/switcher");
  const r = (id: string) => ({ paneId: id, title: id, workspaceId: "w", workspace: "w", agentStatus: "idle" });
  const rows = [r("a"), r("b"), r("c")];
  test("next and previous, wrapping at the ends", () => {
    expect(paneStep(rows, "a", 1)?.paneId).toBe("b");
    expect(paneStep(rows, "c", 1)?.paneId).toBe("a");
    expect(paneStep(rows, "a", -1)?.paneId).toBe("c");
    expect(paneStep(rows, "b", -1)?.paneId).toBe("a");
  });
  test("a current pane not in the list: Down gives the first, Up the last", () => {
    expect(paneStep(rows, "zz", 1)?.paneId).toBe("a");
    expect(paneStep(rows, "zz", -1)?.paneId).toBe("c");
  });
  test("an empty list, or only the current pane: null", () => {
    expect(paneStep([], "a", 1)).toBeNull();
    expect(paneStep([r("a")], "a", 1)).toBeNull();
  });
  test("nth is 1-based; out of range is null", () => {
    expect(nthPane(rows, 1)?.paneId).toBe("a");
    expect(nthPane(rows, 3)?.paneId).toBe("c");
    expect(nthPane(rows, 4)).toBeNull();
    expect(nthPane(rows, 0)).toBeNull();
  });
});
