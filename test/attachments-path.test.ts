import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTER_KEY } from "../src/config";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { ATTACHMENTS_PATH_SPACES, ATTACHMENTS_PATH_SPACES_MESSAGE, sendErrorText } from "../src/send-errors";
import { createServer } from "../src/server";

/*
 * Claude Code reads an `@path` mention up to the first space and does not accept quotes, so an attachment saved under
 * a folder whose path has a space (a Windows profile such as `C:\Users\Jane Doe`) would reach Claude as a broken path.
 * The server refuses such a send before saving anything, with a notice that says what to do; text alone still goes.
 */

const TOKEN = "tok-att";
const root = mkdtempSync(join(tmpdir(), "sidecr-att-"));
const uiDir = join(root, "ui");
mkdirSync(uiDir);
writeFileSync(join(uiDir, "index.html"), "<html></html>");

const sent: string[] = [];
const herdr: HerdrLike = {
  getPane: async (id): Promise<PaneInfo> => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: "s", cwd: root, title: "t", workspaceId: "w1" }),
  listAgentPanes: async () => [],
  listWorkspaces: async () => [],
  readScreen: async () => "output\n> \n",
  sendText: async (_id, t) => void sent.push(`text:${t}`),
  sendKeys: async (_id, k) => void sent.push(`keys:${k.join("+")}`),
};

function serverWith(attachmentsDir: string) {
  const { server } = createServer({ herdr, token: TOKEN, attachmentsDir, projectsRoot: join(root, "projects"), uiDir, distDir: root, opener: async () => {} });
  return server;
}

const spaced = join(root, "Jane Doe", "attachments");
const plain = join(root, "plain", "attachments");
const withSpace = serverWith(spaced);
const withoutSpace = serverWith(plain);
afterAll(() => {
  withSpace.stop(true);
  withoutSpace.stop(true);
});

async function send(server: ReturnType<typeof serverWith>, text: string, file?: string) {
  const form = new FormData();
  form.set("pane", "w1:p1");
  form.set("text", text);
  if (file) form.append("files", new File([new Uint8Array([1, 2, 3])], file, { type: "image/png" }));
  return fetch(`http://127.0.0.1:${Number(server.port)}/api/send`, { method: "POST", body: form, headers: { cookie: `sidecr=${TOKEN}` } });
}

describe("attachments folder with a space in its path", () => {
  test("an attachment is refused with 422 and the notice, and nothing is saved or sent", async () => {
    sent.length = 0;
    const res = await send(withSpace, "look", "shot.png");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: ATTACHMENTS_PATH_SPACES, message: ATTACHMENTS_PATH_SPACES_MESSAGE });
    expect(sent).toEqual([]);
    expect(existsSync(spaced) ? readdirSync(spaced) : []).toEqual([]);
  });

  test("a message without attachments is not affected", async () => {
    sent.length = 0;
    const res = await send(withSpace, "just text");
    expect(res.status).toBe(200);
    expect(sent).toEqual(["text:just text", `keys:${ENTER_KEY}`]);
  });

  test("a folder without spaces (for example one set with SIDECR_ATTACHMENTS_DIR) takes attachments as before", async () => {
    sent.length = 0;
    const res = await send(withoutSpace, "look", "shot.png");
    expect(res.status).toBe(200);
    expect(sent[0]).toMatch(/^text:look @\S*shot\.png$/);
    expect(readdirSync(plain)).toHaveLength(1);
  });
});

describe("the notice", () => {
  test("says what is wrong and what to do, in English", () => {
    expect(ATTACHMENTS_PATH_SPACES_MESSAGE).toBe("Attachments need a folder path without spaces. Set SIDECR_ATTACHMENTS_DIR to one.");
  });
  test("the window shows it for the error code, whatever message came with it", () => {
    expect(sendErrorText(ATTACHMENTS_PATH_SPACES, undefined)).toBe(ATTACHMENTS_PATH_SPACES_MESSAGE);
    expect(sendErrorText(ATTACHMENTS_PATH_SPACES, "something else")).toBe(ATTACHMENTS_PATH_SPACES_MESSAGE);
  });
  test("other errors keep the server's message, or the code, or a generic line", () => {
    expect(sendErrorText("menu-open", "a menu is open in the terminal; answer it there first")).toBe("a menu is open in the terminal; answer it there first");
    expect(sendErrorText("too-large", undefined)).toBe("too-large");
    expect(sendErrorText(undefined, undefined)).toBe("Sending failed.");
  });
});
