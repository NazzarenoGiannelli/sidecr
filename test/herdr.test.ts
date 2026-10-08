import { describe, expect, test } from "bun:test";
import { ENTER_KEY, NEWLINE_KEY } from "../src/config";
import { Herdr, HerdrError, SidecrError, assertSendable, deliver, type Exec, type PaneInfo } from "../src/herdr";

function fakeExec(stdout: string, code = 0): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: async (cmd) => { calls.push(cmd); return { code, stdout, stderr: code ? "boom" : "" }; } };
}

const paneJson = JSON.stringify({
  id: "x",
  result: {
    pane: {
      agent: "claude",
      agent_session: { agent: "claude", kind: "id", value: "sess-1" },
      agent_status: "idle",
      cwd: "C:\\Users\\alice\\Vault",
      pane_id: "w1:p1",
      terminal_title_stripped: "morning",
      workspace_id: "w1",
    },
    type: "pane_info",
  },
});

describe("Herdr", () => {
  test("getPane maps the JSON and calls the binary", async () => {
    const { exec, calls } = fakeExec(paneJson);
    const pane = await new Herdr(exec, "herdr").getPane("w1:p1");
    expect(calls[0]).toEqual(["herdr", "pane", "get", "w1:p1"]);
    expect(pane).toEqual({
      paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: "sess-1",
      cwd: "C:\\Users\\alice\\Vault", title: "morning", workspaceId: "w1",
    });
  });

  test("listAgentPanes maps every agent", async () => {
    const out = JSON.stringify({ result: { agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { value: "s1" }, cwd: "/a", terminal_title_stripped: "A", workspace_id: "w1" },
      { pane_id: "w1:p2", agent: "codex", agent_status: "working", cwd: "/b", terminal_title_stripped: "B", workspace_id: "w1" },
    ], type: "agent_list" } });
    const panes = await new Herdr(fakeExec(out).exec, "herdr").listAgentPanes();
    expect(panes.map((p) => [p.paneId, p.agent, p.sessionId])).toEqual([["w1:p1", "claude", "s1"], ["w1:p2", "codex", null]]);
  });

  test("listWorkspaces maps id and label and calls workspace list", async () => {
    const out = JSON.stringify({ result: { workspaces: [
      { workspace_id: "w6", label: "personal", focused: true },
      { workspace_id: "w7", label: "api" },
      { workspace_id: "w8" },
    ], type: "workspace_list" } });
    const { exec, calls } = fakeExec(out);
    const list = await new Herdr(exec, "herdr").listWorkspaces();
    expect(calls[0]).toEqual(["herdr", "workspace", "list"]);
    expect(list).toEqual([{ id: "w6", label: "personal" }, { id: "w7", label: "api" }, { id: "w8", label: "w8" }]);
  });

  test("listWorkspaces gives an empty list for an unexpected shape", async () => {
    expect(await new Herdr(fakeExec("{}").exec, "herdr").listWorkspaces()).toEqual([]);
  });

  test("a non-zero exit becomes a HerdrError with the CLI message", async () => {
    await expect(new Herdr(fakeExec("", 1).exec, "herdr").getPane("nope")).rejects.toBeInstanceOf(HerdrError);
  });

  test("readScreen returns the raw screen text", async () => {
    const { exec, calls } = fakeExec("line 1\nline 2\n");
    expect(await new Herdr(exec, "herdr").readScreen("w1:p1")).toBe("line 1\nline 2\n");
    expect(calls[0]).toEqual(["herdr", "pane", "read", "w1:p1"]);
  });

  test("sendText and sendKeys pass literal arguments without a shell", async () => {
    const { exec, calls } = fakeExec("{}");
    const h = new Herdr(exec, "herdr");
    await h.sendText("w1:p1", "hello & world");
    await h.sendKeys("w1:p1", ["enter"]);
    expect(calls).toEqual([
      ["herdr", "pane", "send-text", "w1:p1", "hello & world"],
      ["herdr", "pane", "send-keys", "w1:p1", "enter"],
    ]);
  });
});

describe("assertSendable", () => {
  const base: PaneInfo = { paneId: "p", agent: "claude", agentStatus: "idle", sessionId: "s", cwd: "/", title: "t", workspaceId: "w" };
  const calmScreen = "some output\n\u276f \n  Sonnet 5.5 | pal\n";
  const menuScreen = "   Select model\n   1. Default\n   Enter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel\n";
  const code = (fn: () => void): string | null => {
    try { fn(); return null; } catch (e) { return e instanceof SidecrError ? e.code : "other"; }
  };

  test("allows idle, working and done on a calm screen", () => {
    for (const agentStatus of ["idle", "working", "done"]) {
      expect(code(() => assertSendable({ ...base, agentStatus }, calmScreen))).toBeNull();
    }
  });
  test("refuses a pane whose agent status is blocked", () => {
    expect(code(() => assertSendable({ ...base, agentStatus: "blocked" }, calmScreen))).toBe("menu-open");
  });
  test("refuses a slash menu even though the status is still done", () => {
    expect(code(() => assertSendable({ ...base, agentStatus: "done" }, menuScreen))).toBe("menu-open");
  });
  test("prose that merely mentions Esc to cancel does not block", () => {
    const prose = "output\nYou can press Esc to cancel the run at any time.\n❯ \n";
    expect(code(() => assertSendable(base, prose))).toBeNull();
  });
  test("both observed real footers block", () => {
    const a = "Select\n   Enter to set as default · s to use this session only · Esc to cancel\n";
    const b = "Really?\n Enter to confirm · Esc to cancel\n";
    expect(code(() => assertSendable(base, a))).toBe("menu-open");
    expect(code(() => assertSendable(base, b))).toBe("menu-open");
  });
  test("a menu footer far up in the scrollback does not block sending", () => {
    const old = menuScreen + Array.from({ length: 40 }, (_, i) => `later line ${i}`).join("\n") + "\n";
    expect(code(() => assertSendable(base, old))).toBeNull();
  });
  test("refuses a pane that is not Claude", () => {
    expect(code(() => assertSendable({ ...base, agent: "codex" }, calmScreen))).toBe("not-claude");
  });
});

describe("deliver", () => {
  function recorder() {
    const log: string[] = [];
    return {
      log,
      h: {
        getPane: async () => { throw new Error("unused"); },
        listAgentPanes: async () => [],
        listWorkspaces: async () => [],
        readScreen: async () => "",
        sendText: async (_id: string, t: string) => { log.push(`text:${JSON.stringify(t)}`); },
        sendKeys: async (_id: string, k: string[]) => { log.push(`keys:${k.join("+")}`); },
      },
    };
  }

  test("text-enter sends the whole message then Enter", async () => {
    const { h, log } = recorder();
    await deliver(h, "p", "a\nb", "text-enter");
    expect(log).toEqual(['text:"a\\nb"', `keys:${ENTER_KEY}`]);
  });

  test("per-line sends each line with the newline key between and Enter at the end", async () => {
    const { h, log } = recorder();
    await deliver(h, "p", "a\n\nb", "per-line");
    expect(log).toEqual(['text:"a"', `keys:${NEWLINE_KEY}`, `keys:${NEWLINE_KEY}`, 'text:"b"', `keys:${ENTER_KEY}`]);
  });

  test("paste wraps the message in bracketed-paste markers", async () => {
    const { h, log } = recorder();
    await deliver(h, "p", "a\nb", "paste");
    expect(log[0]).toBe('text:"\\u001b[200~a\\nb\\u001b[201~"');
    expect(log[1]).toBe(`keys:${ENTER_KEY}`);
  });

  test("CRLF is normalised before delivery", async () => {
    const { h, log } = recorder();
    await deliver(h, "p", "a\r\nb", "text-enter");
    expect(log[0]).toBe('text:"a\\nb"');
  });
});
