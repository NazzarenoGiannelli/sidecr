/**
 * An invented herdr for the demo: three workspaces (api, web, docs), one Claude Code pane in each, and nothing that
 * ever reaches a real herdr. The api pane is the one the window opens on; its session is the fixture transcript.
 * Sends and keys are only recorded (the demo never sends), the screen is an empty prompt.
 */
import type { HerdrLike, PaneInfo } from "../src/herdr";

export const SESSION = "5d1c9a6e-2f43-4b8e-9a71-3c0e8d4f2b16";
export const CWD = "C:\\Users\\alice\\code\\api";
export const PANE = "w1:p1";
export const MACHINE = "studio";

export const WORKSPACES = [
  { id: "w1", label: "api" },
  { id: "w2", label: "web" },
  { id: "w3", label: "docs" },
];

export const PANES: PaneInfo[] = [
  { paneId: PANE, agent: "claude", agentStatus: "idle", sessionId: SESSION, cwd: CWD, title: "Cursor pagination", workspaceId: "w1" },
  { paneId: "w2:p1", agent: "claude", agentStatus: "working", sessionId: "8b0f3c21-6a54-4d7e-b1c9-0e2d4f6a8c13", cwd: "C:\\Users\\alice\\code\\web", title: "Orders table: Load more button", workspaceId: "w2" },
  { paneId: "w3:p1", agent: "claude", agentStatus: "blocked", sessionId: "c3e1a9b7-0d2f-4c6e-8a1b-5f7d9e3c1a20", cwd: "C:\\Users\\alice\\code\\docs", title: "Rewrite the quickstart", workspaceId: "w3" },
];

export function stubHerdr(sent: string[] = []): HerdrLike {
  return {
    async getPane(id) {
      const p = PANES.find((x) => x.paneId === id);
      if (!p) throw new Error(`pane ${id} not found`);
      return p;
    },
    async listAgentPanes() {
      return PANES;
    },
    async listWorkspaces() {
      return WORKSPACES;
    },
    async readScreen() {
      return "";
    },
    async sendText(id, text) {
      sent.push(`${id} text ${text}`);
    },
    async sendKeys(id, keys) {
      sent.push(`${id} keys ${keys.join("+")}`);
    },
  };
}
