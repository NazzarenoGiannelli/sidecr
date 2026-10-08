import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTER_KEY } from "../src/config";
import { HerdrError, type HerdrLike, type PaneInfo } from "../src/herdr";
import { cookieToken, createServer, isHostAllowed, tokenMatches, type ServerOptions } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";
import { SERVER_API_VERSION } from "../src/version";
import { budget } from "./timing";

const TOKEN = "tok-123";
const root = mkdtempSync(join(tmpdir(), "sidecr-srv-"));
const projects = join(root, "projects");
const attachments = join(root, "attachments");
const uiDir = join(root, "ui");
const distDir = join(root, "dist");
mkdirSync(uiDir); mkdirSync(distDir);
writeFileSync(join(uiDir, "index.html"), "<html>sidecr</html>");
writeFileSync(join(uiDir, "style.css"), "body{}");
writeFileSync(join(uiDir, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
writeFileSync(join(distDir, "app.js"), "//js");

const CWD = join(root, "work");
const imagePath = join(root, "shown.png");
writeFileSync(imagePath, "PNGDATA");
// Files the conversation mentions, so the type check (not the allow-list) is what decides.
const mentioned = ["notes.md", "doc.pdf", "run.exe", "run.py", "run.sh", "run.js", "run.lnk"].map((n) => {
  const p = join(root, n);
  writeFileSync(p, "x");
  return p;
});
let session = "sess-1";

function writeSession(id: string, lines: object[]) {
  const dir = join(projects, encodeCwd(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
writeSession("sess-1", [
  { type: "user", uuid: "u1", message: { role: "user", content: `look ${imagePath}` } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "nice" }] } },
  { type: "user", uuid: "u2", message: { role: "user", content: `files ${mentioned.join(" ")} done` } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
]);
writeSession("sess-2", [
  { type: "user", uuid: "u9", message: { role: "user", content: "after clear" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fresh" }] } },
]);

let status = "idle";
let screen = "output\n❯ \n";
const sent: string[] = [];
const opened: string[] = [];
const herdr: HerdrLike = {
  getPane: async (id): Promise<PaneInfo> => ({
    paneId: id, agent: "claude", agentStatus: status, sessionId: session, cwd: CWD, title: "morning", workspaceId: "w1",
  }),
  listAgentPanes: async () => [
    { paneId: "w1:p1", agent: "claude", agentStatus: "idle", sessionId: "sess-1", cwd: CWD, title: "morning", workspaceId: "w1" },
    { paneId: "w1:p2", agent: "codex", agentStatus: "idle", sessionId: null, cwd: CWD, title: "other", workspaceId: "w1" },
  ],
  listWorkspaces: async () => [{ id: "w1", label: "personal" }],
  readScreen: async () => screen,
  sendText: async (_id, t) => { sent.push(`text:${t}`); },
  sendKeys: async (_id, k) => { sent.push(`keys:${k.join("+")}`); },
};

const { server } = createServer({
  herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
  opener: async (t) => { opened.push(t); },
});
const base = `http://127.0.0.1:${Number(server.port)}`;
const auth = { headers: { cookie: `sidecr=${TOKEN}` } };

afterAll(() => server.stop(true));

describe("auth helpers", () => {
  test("host allow-list", () => {
    expect(isHostAllowed("127.0.0.1:9000", 9000)).toBe(true);
    expect(isHostAllowed("localhost:9000", 9000)).toBe(true);
    expect(isHostAllowed("evil.example", 9000)).toBe(false);
    expect(isHostAllowed("127.0.0.1:9001", 9000)).toBe(false);
    expect(isHostAllowed(null, 9000)).toBe(false);
  });
  test("token and cookie parsing", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(cookieToken("a=1; sidecr=xyz; b=2")).toBe("xyz");
    expect(cookieToken(null)).toBeNull();
  });
});

describe("access", () => {
  test("health needs no token and identifies the app", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ app: "sidecr", pid: process.pid, version: SERVER_API_VERSION });
  });
  test("API without the cookie is refused", async () => {
    expect((await fetch(`${base}/api/panes`)).status).toBe(401);
  });
  test("root with the right token sets the cookie and serves the page", async () => {
    const res = await fetch(`${base}/?t=${TOKEN}&pane=w1:p1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`sidecr=${TOKEN}`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await res.text()).toContain("sidecr");
  });
  test("root with a wrong token is refused", async () => {
    expect((await fetch(`${base}/?t=nope`)).status).toBe(401);
  });
  test("the favicon is served as SVG with the cookie and refused without it", async () => {
    const res = await fetch(`${base}/favicon.svg`, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toContain("<svg");
    expect((await fetch(`${base}/favicon.svg`)).status).toBe(401);
  });
});

describe("api", () => {
  test("panes lists only Claude panes", async () => {
    const res = await fetch(`${base}/api/panes`, auth);
    const body = (await res.json()) as { panes: { paneId: string }[] };
    expect(body.panes.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  test("conversation returns the exchanges of the pane's current session", async () => {
    session = "sess-1";
    const body = (await (await fetch(`${base}/api/conversation?pane=w1:p1`, auth)).json()) as any;
    expect(body.pane.title).toBe("morning");
    expect(body.exchanges[0].assistant[0].text).toBe("nice");
  });

  test("conversation follows a new session id after /clear", async () => {
    session = "sess-2";
    const body = (await (await fetch(`${base}/api/conversation?pane=w1:p1`, auth)).json()) as any;
    expect(body.exchanges[0].user[0].text).toBe("after clear");
    session = "sess-1";
  });

  test("conversation reports a missing transcript", async () => {
    session = "sess-missing";
    const body = (await (await fetch(`${base}/api/conversation?pane=w1:p1`, auth)).json()) as any;
    expect(body.error).toBe("transcript-not-found");
    session = "sess-1";
  });

  test("send delivers text plus @path of the attachment", async () => {
    sent.length = 0;
    const form = new FormData();
    form.set("pane", "w1:p1");
    form.set("text", "see this");
    form.append("files", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatch(/^text:see this @.*attachments.*shot\.png$/);
    expect(sent[1]).toBe(`keys:${ENTER_KEY}`);
  });

  test("send is refused while a menu is open and saves nothing", async () => {
    status = "blocked";
    sent.length = 0;
    const form = new FormData();
    form.set("pane", "w1:p1");
    form.set("text", "hello");
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("menu-open");
    expect(sent).toEqual([]);
    status = "idle";
  });

  test("send is refused while a slash menu is open even though the status is not blocked", async () => {
    screen = "   Select model\n   Enter to set as default · Esc to cancel\n";
    sent.length = 0;
    const form = new FormData();
    form.set("pane", "w1:p1");
    form.set("text", "hello");
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(409);
    expect(sent).toEqual([]);
    screen = "output\n❯ \n";
  });

  test("send rejects an empty message", async () => {
    const form = new FormData();
    form.set("pane", "w1:p1");
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(400);
  });

  test("send refuses a message over 30000 characters before saving any file", async () => {
    sent.length = 0;
    const before = existsSync(attachments) ? readdirSync(attachments) : [];
    const form = new FormData();
    form.set("pane", "w1:p1");
    form.set("text", "x".repeat(30001));
    form.append("files", new File([new Uint8Array([1, 2, 3])], "late.png", { type: "image/png" }));
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too-long", message: "attach long text as a file" });
    expect(sent).toEqual([]);
    expect(existsSync(attachments) ? readdirSync(attachments) : []).toEqual(before);
  });

  test("send counts the @path mentions toward the limit", async () => {
    const form = new FormData();
    form.set("pane", "w1:p1");
    form.set("text", "x".repeat(29990));
    form.append("files", new File([new Uint8Array([1])], "mention.png", { type: "image/png" }));
    const res = await fetch(`${base}/api/send`, { method: "POST", body: form, ...auth });
    expect(res.status).toBe(413);
  });

  test("file serves an image shown in the conversation, nothing else", async () => {
    const ok = await fetch(`${base}/api/file?pane=w1:p1&path=${encodeURIComponent(imagePath)}`, auth);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("PNGDATA");
    const secret = join(root, "secret.png");
    writeFileSync(secret, "S");
    const denied = await fetch(`${base}/api/file?pane=w1:p1&path=${encodeURIComponent(secret)}`, auth);
    expect(denied.status).toBe(403);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=300");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toBe("sandbox");
    const notImage = await fetch(`${base}/api/file?pane=w1:p1&path=${encodeURIComponent(join(CWD, "x.txt"))}`, auth);
    expect(notImage.status).toBe(403);
  });

  test("open accepts http(s) urls, listed paths, and refuses executables and unlisted paths", async () => {
    const post = (body: object) =>
      fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify(body), headers: { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" } });
    opened.length = 0;
    expect((await post({ pane: "w1:p1", kind: "url", target: "https://example.com" })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "url", target: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ pane: "w1:p1", kind: "path", target: imagePath })).status).toBe(200);
    expect((await post({ pane: "w1:p1", kind: "path", target: join(root, "unlisted.md") })).status).toBe(403);
    expect(opened).toEqual(["https://example.com", imagePath]);
  });

  test("open is an allow-list: listed .md, .pdf and .png open, scripts and executables do not", async () => {
    const post = (target: string) =>
      fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify({ pane: "w1:p1", kind: "path", target }), headers: { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" } });
    opened.length = 0;
    for (const name of ["notes.md", "doc.pdf"]) expect((await post(join(root, name))).status).toBe(200);
    expect((await post(imagePath)).status).toBe(200);
    expect(opened).toEqual([join(root, "notes.md"), join(root, "doc.pdf"), imagePath]);
    opened.length = 0;
    for (const name of ["run.exe", "run.py", "run.sh", "run.js", "run.lnk"]) {
      const res = await post(join(root, name));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "type-not-openable", message: "this file type is not opened from here" });
    }
    expect(opened).toEqual([]);
  });
});

describe("window bounds", () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "sidecr-wb-srv-")), "state");
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
    opener: async () => {}, stateDir,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const post = (body: string, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) =>
    fetch(`${b}/api/window-bounds`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  afterAll(() => made.server.stop(true));

  test("a valid POST is written to window.json", async () => {
    const res = await post(JSON.stringify({ x: 3226, y: 159, w: 520, h: 760 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(stateDir, "window.json"), "utf8"))).toEqual({ x: 3226, y: 159, w: 520, h: 760 });
  });

  test("an invalid POST gets 400 and changes nothing", async () => {
    const before = readFileSync(join(stateDir, "window.json"), "utf8");
    for (const bad of [{ x: -32000, y: -32000, w: 160, h: 28 }, { x: "1", y: 2, w: 520, h: 760 }, { x: 1, y: 2, w: 5000, h: 760 }, {}]) {
      const res = await post(JSON.stringify(bad));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad-bounds" });
    }
    expect(readFileSync(join(stateDir, "window.json"), "utf8")).toBe(before);
  });

  test("malformed JSON gets 400", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-bounds" });
  });

  test("without the cookie it is refused", async () => {
    expect((await post(JSON.stringify({ x: 1, y: 2, w: 520, h: 760 }), {})).status).toBe(401);
  });

  test("a wrong Host is refused", async () => {
    const res = await fetch(`${b}/api/window-bounds`, {
      method: "POST", body: JSON.stringify({ x: 1, y: 2, w: 520, h: 760 }),
      headers: { cookie: `sidecr=${TOKEN}`, host: "evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("an invalid POST writes nothing when no file existed", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sidecr-wb-srv-")), "fresh");
    const s = createServer({
      herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
      opener: async () => {}, stateDir: dir,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${Number(s.server.port)}/api/window-bounds`, {
        method: "POST", body: JSON.stringify({ x: 1, y: 2, w: 10, h: 10 }), headers: { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(existsSync(join(dir, "window.json"))).toBe(false);
    } finally {
      s.server.stop(true);
    }
  });
});

describe("cross-site guard and content types", () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "sidecr-xs-")), "state");
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {}, stateDir,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  afterAll(() => made.server.stop(true));

  const form = () => {
    const f = new FormData();
    f.set("pane", "w1:p1");
    f.set("text", "");
    return f; // empty on purpose: a 400 "empty" means the guard let it through, without delivering anything
  };
  const JSON_BODIES: Record<string, { method: string; body: string }> = {
    "/api/stop": { method: "POST", body: JSON.stringify({ pane: "w1:p1" }) },
    "/api/open": { method: "POST", body: JSON.stringify({ pane: "w1:p1", kind: "url", target: "javascript:x" }) },
    "/api/draft": { method: "PUT", body: JSON.stringify({ pane: "w1:p1", text: "t" }) },
    "/api/window-bounds": { method: "POST", body: JSON.stringify({ x: 1, y: 2, w: 520, h: 760 }) },
    "/api/window": { method: "POST", body: JSON.stringify({ id: "xs-window", event: "ping" }) },
    "/api/toggle": { method: "POST", body: JSON.stringify({ pane: "w1:p1" }) },
  };
  const call = (path: string, extra: Record<string, string>) =>
    fetch(`${b}${path}`, { ...JSON_BODIES[path]!, headers: { cookie: `sidecr=${TOKEN}`, "content-type": "application/json", ...extra } });

  test("a cross-site or same-site write is 403 cross-site for each endpoint, including send", async () => {
    for (const site of ["cross-site", "same-site", "weird"]) {
      for (const path of Object.keys(JSON_BODIES)) {
        const res = await call(path, { "sec-fetch-site": site });
        expect([path, site, res.status]).toEqual([path, site, 403]);
        expect(await res.json()).toEqual({ error: "cross-site" });
      }
      const send = await fetch(`${b}/api/send`, { method: "POST", body: form(), headers: { cookie: `sidecr=${TOKEN}`, "sec-fetch-site": site } });
      expect(send.status).toBe(403);
      expect(await send.json()).toEqual({ error: "cross-site" });
    }
  });

  test("the guard runs before the cookie check, after the Host check", async () => {
    const res = await fetch(`${b}/api/stop`, { method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" } });
    expect(res.status).toBe(403);
    const badHost = await fetch(`${b}/api/stop`, { method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site", host: "evil.example" } });
    expect(await badHost.json()).toEqual({ error: "bad-host" });
  });

  test("same-origin, none and no header pass the guard", async () => {
    const variants: Record<string, string>[] = [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}];
    for (const extra of variants) {
      for (const path of Object.keys(JSON_BODIES)) {
        const res = await call(path, extra);
        expect([path, res.status === 403 || res.status === 415]).toEqual([path, false]);
      }
      const send = await fetch(`${b}/api/send`, { method: "POST", body: form(), headers: { cookie: `sidecr=${TOKEN}`, ...extra } });
      expect(send.status).toBe(400);
    }
  });

  test("a cross-site GET is not blocked by the write guard", async () => {
    const res = await fetch(`${b}/api/panes`, { headers: { cookie: `sidecr=${TOKEN}`, "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(200);
  });

  test("a JSON endpoint with another content type is 415, with or without a charset suffix it passes", async () => {
    for (const path of Object.keys(JSON_BODIES)) {
      for (const type of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded"]) {
        const res = await call(path, { "content-type": type });
        expect([path, type, res.status]).toEqual([path, type, 415]);
        expect(await res.json()).toEqual({ error: "unsupported-media-type" });
      }
      const noType = await fetch(`${b}${path}`, { ...JSON_BODIES[path]!, headers: { cookie: `sidecr=${TOKEN}`, "content-type": "" } });
      expect([path, noType.status]).toEqual([path, 415]);
      for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
        const res = await call(path, { "content-type": type });
        expect([path, type, res.status === 415]).toEqual([path, type, false]);
      }
    }
  });

  test("send stays multipart", async () => {
    const res = await fetch(`${b}/api/send`, { method: "POST", body: form(), headers: { cookie: `sidecr=${TOKEN}` } });
    expect(res.status).toBe(400);
  });
});

describe("workspace label and machine name", () => {
  let listCalls = 0;
  let workspaces: { id: string; label: string }[] = [{ id: "w1", label: "personal" }];
  let wsFails = false;
  const h: HerdrLike = {
    ...herdr,
    listWorkspaces: async () => {
      listCalls++;
      if (wsFails) throw new Error("workspace list failed");
      return workspaces;
    },
  };
  const made = createServer({
    herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
    opener: async () => {}, machineName: "desk",
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const conv = async () => (await (await fetch(`${b}/api/conversation?pane=w1:p1`, auth)).json()) as any;
  afterAll(() => made.server.stop(true));

  test("the conversation carries the workspace label and the machine name", async () => {
    const body = await conv();
    expect(body.pane.workspace).toBe("personal");
    expect(body.machine).toBe("desk");
  });

  test("/api/panes rows carry the workspace label", async () => {
    const body = (await (await fetch(`${b}/api/panes`, auth)).json()) as any;
    expect(body.panes.map((p: any) => [p.paneId, p.workspace])).toEqual([["w1:p1", "personal"]]);
  });

  test("machine is an empty string when no name is configured", async () => {
    const body = (await (await fetch(`${base}/api/conversation?pane=w1:p1`, auth)).json()) as any;
    expect(body.machine).toBe("");
  });

  test("one listWorkspaces call serves requests within 5 s", async () => {
    const own = createServer({
      herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
    });
    try {
      const url = `http://127.0.0.1:${Number(own.server.port)}`;
      listCalls = 0;
      await fetch(`${url}/api/conversation?pane=w1:p1`, auth);
      await fetch(`${url}/api/conversation?pane=w1:p1`, auth);
      await fetch(`${url}/api/panes`, auth);
      expect(listCalls).toBe(1);
    } finally {
      own.server.stop(true);
    }
  });

  test("concurrent requests share one listWorkspaces call", async () => {
    const own = createServer({
      herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
    });
    try {
      const url = `http://127.0.0.1:${Number(own.server.port)}`;
      listCalls = 0;
      await Promise.all([1, 2, 3].map(() => fetch(`${url}/api/conversation?pane=w1:p1`, auth)));
      expect(listCalls).toBe(1);
    } finally {
      own.server.stop(true);
    }
  });

  test("the cache expires", async () => {
    const own = createServer({
      herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
      workspaceCacheMs: 30,
    });
    try {
      const url = `http://127.0.0.1:${Number(own.server.port)}`;
      listCalls = 0;
      await fetch(`${url}/api/conversation?pane=w1:p1`, auth);
      await Bun.sleep(60);
      await fetch(`${url}/api/conversation?pane=w1:p1`, auth);
      expect(listCalls).toBe(2);
    } finally {
      own.server.stop(true);
    }
  });

  test("an unknown workspace id falls back to the id", async () => {
    const odd: HerdrLike = { ...h, getPane: async (id) => ({ ...(await herdr.getPane(id)), workspaceId: "w9" }) };
    const own = createServer({
      herdr: odd, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
    });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${Number(own.server.port)}/api/conversation?pane=w1:p1`, auth)).json()) as any;
      expect(body.pane.workspace).toBe("w9");
    } finally {
      own.server.stop(true);
    }
  });

  test("a failing workspace list does not fail the conversation: ids are used", async () => {
    const own = createServer({
      herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
    });
    try {
      wsFails = true;
      const res = await fetch(`http://127.0.0.1:${Number(own.server.port)}/api/conversation?pane=w1:p1`, auth);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).pane.workspace).toBe("w1");
    } finally {
      wsFails = false;
      own.server.stop(true);
    }
  });
});

describe("activity and stop", () => {
  const SPIN_SCREEN = "output\n* Considering… (1m 44s · ↓ 9.0k tokens)\n❯ \n";
  let st = "working";
  let scr = SPIN_SCREEN;
  let screenFails = false;
  let agent: string | null = "claude";
  let screenCalls = 0;
  let clock = 1_000_000; // the stop cooldown reads this: tests advance it instead of waiting
  const keys: string[] = [];
  const texts: string[] = [];
  const h: HerdrLike = {
    ...herdr,
    getPane: async (id): Promise<PaneInfo> => {
      if (id === "w1:gone") throw new HerdrError("pane w1:gone not found");
      return { paneId: id, agent, agentStatus: st, sessionId: "sess-act", cwd: CWD, title: "act", workspaceId: "w1" };
    },
    readScreen: async () => {
      screenCalls++;
      if (screenFails) throw new Error("no screen");
      return scr;
    },
    sendText: async (_id, t) => { texts.push(t); },
    sendKeys: async (_id, k) => { keys.push(k.join("+")); },
  };
  writeSession("sess-act", [
    { type: "user", uuid: "a1", timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "work" } },
    { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "on it" }], usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "on it" }], usage: { input_tokens: 100, output_tokens: 30 } } },
  ]);
  const made = createServer({
    herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {}, now: () => clock,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const conv = async () => (await (await fetch(`${b}/api/conversation?pane=w1:p1`, auth)).json()) as any;
  const stop = (body: string, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) =>
    fetch(`${b}/api/stop`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  afterAll(() => made.server.stop(true));

  test("working with a spinner on screen: source screen plus transcript data", async () => {
    st = "working";
    const body = await conv();
    expect(body.activity).toEqual({
      source: "screen", verb: "Considering", elapsedSec: 104, detail: "↓ 9.0k tokens",
      startedAt: "2026-10-01T09:00:00.000Z", tokens: { input: 100, output: 30 },
    });
  });

  test("working without a spinner line: source transcript", async () => {
    scr = "just output\n❯ \n";
    const body = await conv();
    expect(body.activity).toEqual({ source: "transcript", startedAt: "2026-10-01T09:00:00.000Z", tokens: { input: 100, output: 30 } });
    scr = SPIN_SCREEN;
  });

  test("a screen that cannot be read falls back to the transcript", async () => {
    screenFails = true;
    try {
      const res = await fetch(`${b}/api/conversation?pane=w1:p1`, auth);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).activity.source).toBe("transcript");
    } finally {
      screenFails = false;
    }
  });

  test("a spinner without detail leaves detail out", async () => {
    scr = "✻ Cooking… (3s)\n";
    const body = await conv();
    expect(body.activity.verb).toBe("Cooking");
    expect(body.activity.elapsedSec).toBe(3);
    expect("detail" in body.activity).toBe(false);
    scr = SPIN_SCREEN;
  });

  test("not working: no activity and the screen is not read", async () => {
    for (const idle of ["idle", "blocked", "done"]) {
      st = idle;
      screenCalls = 0;
      const body = await conv();
      expect("activity" in body).toBe(false);
      expect(screenCalls).toBe(0);
    }
    st = "working";
  });

  test("a working pane that is not Claude has no activity and its screen is not read", async () => {
    agent = "codex";
    st = "working";
    screenCalls = 0;
    try {
      const body = await conv();
      expect("activity" in body).toBe(false);
      expect(screenCalls).toBe(0);
    } finally {
      agent = "claude";
    }
  });

  test("stop on a working Claude pane sends exactly one esc", async () => {
    clock += 5000;
    st = "working";
    keys.length = 0; texts.length = 0;
    const res = await stop(JSON.stringify({ pane: "w1:p1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(keys).toEqual(["esc"]);
    expect(texts).toEqual([]);
  });

  test("stop on an idle pane is 409 and sends nothing", async () => {
    clock += 5000;
    keys.length = 0;
    for (const idle of ["idle", "blocked", "done", "unknown"]) {
      st = idle;
      const res = await stop(JSON.stringify({ pane: "w1:p1" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "not-working", message: "Claude is not working" });
    }
    expect(keys).toEqual([]);
    st = "working";
  });

  test("stop on a pane that is not Claude, or does not exist, is 409 and sends nothing", async () => {
    clock += 5000;
    keys.length = 0;
    agent = "codex";
    try {
      expect((await stop(JSON.stringify({ pane: "w1:p1" }))).status).toBe(409);
    } finally {
      agent = "claude";
    }
    const gone = await stop(JSON.stringify({ pane: "w1:gone" }));
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as any).error).toBe("not-working");
    expect(keys).toEqual([]);
  });

  test("stop without the cookie is 401, with a wrong Host 403, with GET 405", async () => {
    keys.length = 0;
    expect((await stop(JSON.stringify({ pane: "w1:p1" }), {})).status).toBe(401);
    expect((await stop(JSON.stringify({ pane: "w1:p1" }), { cookie: `sidecr=${TOKEN}`, host: "evil.example" })).status).toBe(403);
    expect((await fetch(`${b}/api/stop`, auth)).status).toBe(405);
    expect(keys).toEqual([]);
  });

  test("stop with a bad body is 400 and sends nothing", async () => {
    keys.length = 0;
    for (const bad of ["{nope", "", "null", "[]", JSON.stringify({}), JSON.stringify({ pane: 7 }), JSON.stringify({ pane: "" })]) {
      expect((await stop(bad)).status).toBe(400);
    }
    expect(keys).toEqual([]);
  });
});

describe("conversation payload", () => {
  test("the workspace list and the screen are fetched together, not one after the other", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let labelsStarted = false;
    let screenStarted = false;
    const h: HerdrLike = {
      ...herdr,
      getPane: async (id) => ({ ...(await herdr.getPane(id)), agentStatus: "working" }),
      // Each call waits for the other to have started: sequential awaiting would never get past the first one.
      listWorkspaces: async () => { labelsStarted = true; if (screenStarted) release(); await gate; return [{ id: "w1", label: "personal" }]; },
      readScreen: async () => { screenStarted = true; if (labelsStarted) release(); await gate; return "* Considering… (3s)\n"; },
    };
    const own = createServer({ herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${Number(own.server.port)}/api/conversation?pane=w1:p1`, { ...auth, signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as any;
      expect(body.pane.workspace).toBe("personal");
      expect(body.activity.verb).toBe("Considering");
    } finally {
      release();
      own.server.stop(true);
    }
  });

  test("a message queued while Claude works does not restart the clock or the token total", async () => {
    writeSession("sess-queued", [
      { type: "user", uuid: "k1", timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "start" } },
      { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "going" }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: "attachment", uuid: "k2", timestamp: "2026-10-01T09:03:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: "and this" } },
      { type: "assistant", message: { role: "assistant", id: "m2", content: [{ type: "text", text: "both" }], usage: { input_tokens: 20, output_tokens: 7 } } },
    ]);
    const h: HerdrLike = {
      ...herdr,
      getPane: async (id) => ({ ...(await herdr.getPane(id)), agentStatus: "working", sessionId: "sess-queued" }),
      readScreen: async () => "no spinner\n",
    };
    const own = createServer({ herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {} });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${Number(own.server.port)}/api/conversation?pane=w1:p1`, auth)).json()) as any;
      expect(body.exchanges.map((e: any) => [e.user[0].text, e.queued === true])).toEqual([["start", false], ["and this", true]]);
      expect(body.activity).toEqual({ source: "transcript", startedAt: "2026-10-01T09:00:00.000Z", tokens: { input: 30, output: 12 } });
    } finally {
      own.server.stop(true);
    }
  });
});

describe("drafts endpoints", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sidecr-draft-srv-")), "state");
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {}, stateDir: dir,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const put = (body: string, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) =>
    fetch(`${b}/api/draft`, { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });
  const get = (pane: string, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) =>
    fetch(`${b}/api/draft?pane=${encodeURIComponent(pane)}`, { headers });
  afterAll(() => made.server.stop(true));

  test("an unknown pane has an empty draft", async () => {
    const res = await get("w1:p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "" });
  });

  test("PUT stores a draft that GET returns, per pane", async () => {
    const res = await put(JSON.stringify({ pane: "w1:p1", text: "half\ntyped " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await (await get("w1:p1")).json()).toEqual({ text: "half\ntyped " });
    expect(await (await get("w1:p2")).json()).toEqual({ text: "" });
    expect(JSON.parse(readFileSync(join(dir, "drafts.json"), "utf8"))["w1:p1"].text).toBe("half\ntyped ");
  });

  test("an empty text clears the draft", async () => {
    await put(JSON.stringify({ pane: "w1:p3", text: "x" }));
    expect((await put(JSON.stringify({ pane: "w1:p3", text: "" }))).status).toBe(200);
    expect(await (await get("w1:p3")).json()).toEqual({ text: "" });
  });

  test("text over 20000 characters is 413 too-long and changes nothing", async () => {
    await put(JSON.stringify({ pane: "w1:p4", text: "keep" }));
    const res = await put(JSON.stringify({ pane: "w1:p4", text: "x".repeat(20001) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too-long" });
    expect(await (await get("w1:p4")).json()).toEqual({ text: "keep" });
    expect((await put(JSON.stringify({ pane: "w1:p4", text: "x".repeat(20000) }))).status).toBe(200);
  });

  test("a bad body is 400", async () => {
    for (const bad of ["{nope", "", "null", "[]", "{}", JSON.stringify({ pane: "p" }), JSON.stringify({ text: "t" }),
      JSON.stringify({ pane: 3, text: "t" }), JSON.stringify({ pane: "p", text: 3 }), JSON.stringify({ pane: "", text: "t" }),
      JSON.stringify({ pane: "p".repeat(300), text: "t" })]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await fetch(`${b}/api/draft`, auth)).status).toBe(400); // GET without a pane
  });

  test("the cookie and the Host check apply", async () => {
    expect((await put(JSON.stringify({ pane: "p", text: "t" }), {})).status).toBe(401);
    expect((await get("p", {})).status).toBe(401);
    expect((await put(JSON.stringify({ pane: "p", text: "t" }), { cookie: `sidecr=${TOKEN}`, host: "evil.example" })).status).toBe(403);
    expect((await get("p", { cookie: `sidecr=${TOKEN}`, host: "evil.example" })).status).toBe(403);
  });

  test("other methods are 405", async () => {
    const res = await fetch(`${b}/api/draft`, { method: "DELETE", ...auth });
    expect(res.status).toBe(405);
  });

  test("without a state directory the endpoints are 404", async () => {
    const s = createServer({ herdr, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {} });
    try {
      const u = `http://127.0.0.1:${Number(s.server.port)}/api/draft`;
      expect((await fetch(`${u}?pane=p`, auth)).status).toBe(404);
      expect((await fetch(u, { method: "PUT", body: JSON.stringify({ pane: "p", text: "t" }), headers: { cookie: `sidecr=${TOKEN}` } })).status).toBe(404);
    } finally {
      s.server.stop(true);
    }
  });
});

describe("stop cooldown", () => {
  let clock = 1_000_000;
  let st = "working";
  let getPaneError: Error | null = null;
  let sendFails = false;
  const keys: string[] = [];
  const h: HerdrLike = {
    ...herdr,
    getPane: async (id): Promise<PaneInfo> => {
      await Bun.sleep(15); // a real herdr call takes time: concurrent requests overlap here
      if (getPaneError) throw getPaneError;
      if (id === "w1:gone") throw new HerdrError("pane w1:gone not found");
      return { paneId: id, agent: "claude", agentStatus: st, sessionId: "s", cwd: CWD, title: "t", workspaceId: "w1" };
    },
    sendKeys: async (id, k) => {
      await Bun.sleep(15);
      if (sendFails) throw new HerdrError("send failed");
      keys.push(`${id}:${k.join("+")}`);
    },
  };
  const made = createServer({
    herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir, opener: async () => {},
    now: () => clock,
  });
  const b = `http://127.0.0.1:${Number(made.server.port)}`;
  const stop = (pane: string) =>
    fetch(`${b}/api/stop`, { method: "POST", body: JSON.stringify({ pane }), headers: { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" } });
  afterAll(() => made.server.stop(true));

  test("two quick stops on a pane that stays working send one esc; the second is deduped", async () => {
    keys.length = 0;
    const first = await stop("w1:a");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    clock += 300;
    const second = await stop("w1:a");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, deduped: true });
    expect(keys).toEqual(["w1:a:esc"]);
  });

  test("a stop after the cooldown sends again", async () => {
    keys.length = 0;
    clock += 1600;
    const res = await stop("w1:a");
    expect(await res.json()).toEqual({ ok: true });
    expect(keys).toEqual(["w1:a:esc"]);
  });

  test("two concurrent stops send exactly one esc", async () => {
    keys.length = 0;
    clock += 5000;
    const [x, y] = await Promise.all([stop("w1:c"), stop("w1:c")]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const bodies = [(await x.json()) as any, (await y.json()) as any];
    expect(bodies.filter((r) => r.deduped === true)).toHaveLength(1);
    expect(keys).toEqual(["w1:c:esc"]);
  });

  test("another pane is not affected by a pane's cooldown", async () => {
    keys.length = 0;
    clock += 5000;
    await stop("w1:d");
    const other = await stop("w1:e");
    expect(await other.json()).toEqual({ ok: true });
    expect(keys).toEqual(["w1:d:esc", "w1:e:esc"]);
  });

  test("an unknown pane is 409 and sends nothing", async () => {
    keys.length = 0;
    const res = await stop("w1:gone");
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("not-working");
    expect(keys).toEqual([]);
  });

  test("a herdr failure other than not-found is 502 with its message and sends nothing", async () => {
    keys.length = 0;
    clock += 5000;
    getPaneError = new HerdrError("herdr is not running");
    try {
      const res = await stop("w1:f");
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "herdr", message: "herdr is not running" });
    } finally {
      getPaneError = null;
    }
    expect(keys).toEqual([]);
  });

  test("the CLI's pane_not_found error is also a 409", async () => {
    getPaneError = new HerdrError('{"error":{"code":"pane_not_found","message":"pane w9:p9 not found"}}');
    try {
      expect((await stop("w9:p9")).status).toBe(409);
    } finally {
      getPaneError = null;
    }
  });

  test("only an error about a pane not being found is a 409; 'socket not found' is a 502", async () => {
    keys.length = 0;
    clock += 5000;
    const cases: [string, number][] = [
      ["pane w99:p99 not found", 409],
      ["Error: pane w99:p99 was not found", 409],
      ['{"error":{"code":"pane_not_found","message":"no such thing"}}', 409],
      ["socket not found", 502],
      ["herdr socket /run/user/1000/herdr.sock not found", 502],
      ["workspace w9 not found", 502],
    ];
    for (const [message, status] of cases) {
      getPaneError = new HerdrError(message);
      try {
        const res = await stop("w9:p9");
        expect([message, res.status]).toEqual([message, status]);
      } finally {
        getPaneError = null;
      }
    }
    expect(keys).toEqual([]);
  });

  test("a very long error message is scanned in bounded time", async () => {
    getPaneError = new HerdrError("pane ".repeat(100000) + "socket");
    try {
      const t = performance.now();
      expect((await stop("w9:p9")).status).toBe(502);
      expect(performance.now() - t).toBeLessThan(budget(1000));
    } finally {
      getPaneError = null;
    }
  });

  test("a stop that is refused (idle) does not start a cooldown", async () => {
    keys.length = 0;
    clock += 5000;
    st = "idle";
    expect((await stop("w1:g")).status).toBe(409);
    st = "working";
    expect(await (await stop("w1:g")).json()).toEqual({ ok: true });
    expect(keys).toEqual(["w1:g:esc"]);
  });

  test("a failed send releases the cooldown so a retry can go through", async () => {
    keys.length = 0;
    clock += 5000;
    sendFails = true;
    try {
      expect((await stop("w1:h")).status).toBe(502);
    } finally {
      sendFails = false;
    }
    expect(await (await stop("w1:h")).json()).toEqual({ ok: true });
    expect(keys).toEqual(["w1:h:esc"]);
  });
});

describe("events stream", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeAll(() => { process.on("unhandledRejection", onUnhandled); });
  afterAll(() => { process.off("unhandledRejection", onUnhandled); });

  function serverWith(h: HerdrLike, extra: Partial<ServerOptions> = {}) {
    const made = createServer({
      herdr: h, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
      opener: async () => {}, ...extra,
    });
    return { ...made, url: `http://127.0.0.1:${Number(made.server.port)}/api/events?pane=w1:p1` };
  }

  test("cancelling while a tick is in flight raises nothing and releases the stream", async () => {
    unhandled.length = 0;
    let getPaneCalls = 0;
    const slow: HerdrLike = {
      ...herdr,
      getPane: async (id) => { getPaneCalls++; await Bun.sleep(300); return herdr.getPane(id); },
    };
    const { server: s, stats, url } = serverWith(slow);
    try {
      const ctl = new AbortController();
      // Headers only go out with the first event, so do not await the fetch: abort while the first tick waits on getPane.
      const pending = fetch(url, { ...auth, signal: ctl.signal }).catch(() => null);
      while (stats.sse < 1) await Bun.sleep(5);
      await Bun.sleep(50);
      expect(getPaneCalls).toBe(1);
      ctl.abort();
      await pending;
      await Bun.sleep(700); // past the delay: the in-flight tick resumes after the cancel
      expect(stats.sse).toBe(0);
      expect(unhandled).toEqual([]);
      expect(getPaneCalls).toBe(1); // ticks do not overlap while one is in flight
    } finally {
      s.stop(true);
    }
  });

  test("an unavailable herdr is probed once per cache window, not on every tick", async () => {
    let getPaneCalls = 0;
    const down: HerdrLike = {
      ...herdr,
      getPane: async () => { getPaneCalls++; throw new Error("herdr is down"); },
    };
    const { server: s, stats, url } = serverWith(down);
    try {
      const ctl = new AbortController();
      await fetch(url, { ...auth, signal: ctl.signal });
      await Bun.sleep(1300); // ticks at 0, 500 and 1000 ms
      ctl.abort();
      await Bun.sleep(100);
      expect(getPaneCalls).toBe(1);
      expect(stats.sse).toBe(0);
    } finally {
      s.stop(true);
    }
  });

  test("after repeated failed probes the stream says gone and closes itself", async () => {
    let getPaneCalls = 0;
    const down: HerdrLike = {
      ...herdr,
      getPane: async () => { getPaneCalls++; throw new Error("pane is gone"); },
    };
    const { server: s, stats, url } = serverWith(down, { sseMaxFailures: 3, sseCacheMs: 10 });
    try {
      const res = await fetch(url, auth);
      const text = await Promise.race([res.text(), Bun.sleep(5000).then(() => "TIMEOUT")]);
      expect(text).toContain("data: gone");
      expect(text.trimEnd().endsWith("data: gone")).toBe(true); // nothing after gone
      expect(getPaneCalls).toBe(3);
      await Bun.sleep(100);
      expect(stats.sse).toBe(0);
    } finally {
      s.stop(true);
    }
  });

  test("a success resets the failure count", async () => {
    let calls = 0;
    const flaky: HerdrLike = {
      ...herdr,
      // fail, succeed, fail, succeed ...: with a limit of 2 it only survives if a success resets the count
      getPane: async (id) => { if (++calls % 2 === 1) throw new Error("hiccup"); return herdr.getPane(id); },
    };
    const { server: s, stats, url } = serverWith(flaky, { sseMaxFailures: 2, sseCacheMs: 10 });
    try {
      const ctl = new AbortController();
      const res = await fetch(url, { ...auth, signal: ctl.signal });
      const reader = res.body!.getReader();
      let text = "";
      const until = Date.now() + 1800;
      while (Date.now() < until) {
        const r = await Promise.race([reader.read(), Bun.sleep(200).then(() => null)]);
        if (r?.value) text += new TextDecoder().decode(r.value);
        if (r?.done) break;
      }
      ctl.abort();
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(text).not.toContain("gone");
      await Bun.sleep(100);
      expect(stats.sse).toBe(0);
    } finally {
      s.stop(true);
    }
  });
});

describe("allowed-path memo", () => {
  test("two file requests within 2 s cost one getPane; a grown transcript is not served from the memo", async () => {
    let getPaneCalls = 0;
    const counting: HerdrLike = {
      ...herdr,
      getPane: async (id) => { getPaneCalls++; return { ...(await herdr.getPane(id)), sessionId: "sess-memo" }; },
    };
    writeSession("sess-memo", [
      { type: "user", uuid: "m1", message: { role: "user", content: `memo ${imagePath}` } },
    ]);
    const made = createServer({
      herdr: counting, token: TOKEN, attachmentsDir: attachments, projectsRoot: projects, uiDir, distDir,
      opener: async () => {},
    });
    try {
      const b = `http://127.0.0.1:${Number(made.server.port)}`;
      const get = () => fetch(`${b}/api/file?pane=w1:p1&path=${encodeURIComponent(imagePath)}`, auth);
      expect((await get()).status).toBe(200);
      expect((await get()).status).toBe(200);
      expect(getPaneCalls).toBe(1);
      const file = join(projects, encodeCwd(CWD), "sess-memo.jsonl");
      appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }) + "\n");
      expect((await get()).status).toBe(200);
      expect(getPaneCalls).toBe(2);
    } finally {
      made.server.stop(true);
    }
  });
});
