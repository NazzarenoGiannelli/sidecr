import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { createServer } from "../src/server";
import {
  ACCENTS,
  applyPatch,
  createSettingsStore,
  defaultSettings,
  GROUPS,
  readSettings,
  SCHEMA,
  SETTINGS_FILE,
  validateSettings,
  validValue,
  writeSettings,
} from "../src/settings";
import { encodeCwd } from "../src/transcript/locate";

const fresh = () => mkdtempSync(join(tmpdir(), "sidecr-settings-"));

describe("schema", () => {
  test("every setting has a label, a known group and a default its own validator accepts", () => {
    const groups = new Set(GROUPS.map((g) => g.id));
    for (const def of SCHEMA) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(groups.has(def.group)).toBe(true);
      expect(validValue(def, def.default)).toEqual(def.default);
    }
    expect(new Set(SCHEMA.map((d) => d.id)).size).toBe(SCHEMA.length);
  });
  test("the approved first set and its defaults", () => {
    expect(defaultSettings()).toEqual({
      acrylic: true,
      effect: "acrylic",
      strength: 60,
      accent: "#5347fd",
      alwaysOnTop: true,
      notifyOnFinish: true,
      exchangesShown: 5,
      loadBlock: 10,
      textSize: "medium",
      sendKey: "enter",
      followFocus: "idle",
    });
    expect(ACCENTS).toHaveLength(6);
    expect(ACCENTS[0]!.value).toBe("#5347fd");
  });
  test("loadBlock: 5, 10 or 20 earlier exchanges per load, default 10, in the Behaviour group", () => {
    const def = SCHEMA.find((d) => d.id === "loadBlock")!;
    expect(def.group).toBe("behaviour");
    expect(def.type === "choice" && def.choices.map((c) => c.value)).toEqual([5, 10, 20]);
    expect(def.default).toBe(10);
    expect(validateSettings({ loadBlock: 15 }).loadBlock).toBe(10);
    expect(validateSettings({ loadBlock: 20 }).loadBlock).toBe(20);
  });
  test("followFocus: Always, When idle or Off, default When idle, in the Behaviour group, with the agreed label", () => {
    const def = SCHEMA.find((d) => d.id === "followFocus")!;
    expect(def.group).toBe("behaviour");
    expect(def.label).toBe("Follow the pane selected in herdr");
    expect(def.type === "choice" && def.choices.map((c) => c.value)).toEqual(["auto", "idle", "off"]);
    expect(def.default).toBe("idle");
    expect(validateSettings({}).followFocus).toBe("idle");
    expect(validateSettings({ followFocus: "auto" }).followFocus).toBe("auto");
    expect(validateSettings({ followFocus: "off" }).followFocus).toBe("off");
    expect(validateSettings({ followFocus: "always" }).followFocus).toBe("idle");
    expect(validateSettings({ followFocus: true }).followFocus).toBe("idle");
  });
  test("appearance and window are shell only, behaviour is not", () => {
    expect(GROUPS.map((g) => [g.id, g.shellOnly])).toEqual([["appearance", true], ["window", true], ["behaviour", false]]);
  });
});

describe("validation", () => {
  test("unknown keys are dropped, invalid values replaced by the default per key, never throws", () => {
    const v = validateSettings({ acrylic: "yes", effect: "mica", strength: 140, accent: "#E0457B", exchangesShown: "10", textSize: "large", extra: 1 });
    expect(v.acrylic).toBe(true); // not a boolean: default
    expect(v.effect).toBe("mica");
    expect(v.strength).toBe(60); // out of range: default
    expect(v.accent).toBe("#e0457b"); // in the palette, any case, stored lowercase
    expect(v.exchangesShown).toBe(5); // a string is not one of the numbers
    expect(v.textSize).toBe("large");
    expect("extra" in v).toBe(false);
    for (const raw of [null, undefined, 42, "x", [], [1, 2]]) expect(validateSettings(raw)).toEqual(defaultSettings());
  });
  test("ranges: integers within bounds pass, a fraction snaps to the step, NaN and Infinity do not", () => {
    const strength = SCHEMA.find((d) => d.id === "strength")!;
    expect(validValue(strength, 0)).toBe(0);
    expect(validValue(strength, 100)).toBe(100);
    expect(validValue(strength, 33.6)).toBe(34);
    for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "50", null]) expect(validValue(strength, bad)).toBeUndefined();
  });
  test("a colour outside the palette is refused", () => {
    const accent = SCHEMA.find((d) => d.id === "accent")!;
    expect(validValue(accent, "#123456")).toBeUndefined();
    expect(validValue(accent, "red")).toBeUndefined();
  });
  test("applyPatch: valid keys change, invalid and unknown keys are listed and change nothing", () => {
    const base = defaultSettings();
    const r = applyPatch(base, { strength: 20, effect: "plasma", nope: true, sendKey: "ctrl-enter" });
    expect(r.settings.strength).toBe(20);
    expect(r.settings.sendKey).toBe("ctrl-enter");
    expect(r.settings.effect).toBe("acrylic");
    expect(r.rejected.sort()).toEqual(["effect", "nope"]);
    expect(base.strength).toBe(60); // the input is not mutated
    expect(applyPatch(base, [1]).rejected).toEqual(["*"]);
    expect(applyPatch(base, "x").settings).toEqual(base);
  });
});

describe("settings.json store", () => {
  test("missing file: defaults", () => {
    expect(readSettings(fresh())).toEqual(defaultSettings());
  });
  test("corrupt file: defaults", () => {
    const dir = fresh();
    writeFileSync(join(dir, SETTINGS_FILE), "{not json");
    expect(readSettings(dir)).toEqual(defaultSettings());
  });
  test("a hand-edited file keeps its valid values and loses the rest", () => {
    const dir = fresh();
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ alwaysOnTop: false, strength: "high", theme: "light" }));
    const s = readSettings(dir);
    expect(s.alwaysOnTop).toBe(false);
    expect(s.strength).toBe(60);
    expect("theme" in s).toBe(false);
  });
  test("write and read back; the write leaves no temp file", () => {
    const dir = join(fresh(), "nested");
    writeSettings(dir, { ...defaultSettings(), textSize: "small" });
    expect(readSettings(dir).textSize).toBe("small");
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE]);
  });
  test("the write retries a rename that fails with EPERM, like drafts.json", () => {
    const dir = fresh();
    let calls = 0;
    const waits: number[] = [];
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    writeSettings(dir, defaultSettings(), {
      rename: (a, b) => {
        if (++calls === 1) throw Object.assign(new Error("busy"), { code: "EPERM" });
        renameSync(a, b);
      },
      wait: (ms) => waits.push(ms),
    });
    expect(waits).toEqual([20]);
    expect(readSettings(dir)).toEqual(defaultSettings());
  });
  test("createSettingsStore: updates persist; nothing is written when nothing valid changed", () => {
    const dir = fresh();
    const store = createSettingsStore(dir);
    expect(store.update({ bogus: 1 }).changed).toBe(false);
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(false);
    const r = store.update({ exchangesShown: 10 });
    expect(r.changed).toBe(true);
    expect(readSettings(dir).exchangesShown).toBe(10);
    expect(createSettingsStore(dir).get().exchangesShown).toBe(10);
  });
  test("createSettingsStore picks up a hand edit of the file while it runs", () => {
    const dir = fresh();
    const store = createSettingsStore(dir);
    store.update({ strength: 10 });
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ ...defaultSettings(), textSize: "large", strength: 90 }));
    utimesSync(join(dir, SETTINGS_FILE), new Date(), new Date(Date.now() + 5000)); // a distinct mtime even on a coarse clock
    expect(store.get().textSize).toBe("large");
    expect(store.update({ sendKey: "ctrl-enter" }).settings).toEqual({ ...defaultSettings(), textSize: "large", strength: 90, sendKey: "ctrl-enter" });
  });
  test("createSettingsStore without a directory keeps the settings in memory", () => {
    const store = createSettingsStore(undefined);
    store.update({ textSize: "large" });
    expect(store.get().textSize).toBe("large");
  });
  test("a failed write leaves the store on the old settings", () => {
    const dir = fresh();
    const store = createSettingsStore(dir, { rename: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, wait: () => {} });
    expect(() => store.update({ strength: 10 })).toThrow();
    expect(store.get().strength).toBe(60);
  });
});

describe("GET/PUT /api/settings and the settings event", () => {
  const TOKEN = "tok-set";
  const root = fresh();
  const stateDir = join(root, "state");
  const projects = join(root, "projects");
  const cwd = join(root, "work");
  const uiDir = join(root, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "lightbox.html"), "<html>lightbox</html>");
  writeFileSync(join(root, "lightbox.js"), "//lb");
  // Six exchanges, the third with an image pasted into the terminal (base64 in the transcript).
  const dir = join(projects, encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const png = Buffer.from("fake png bytes").toString("base64");
  // The first exchange mentions an image file, so it can be previewed only while that exchange is shown.
  const oldShot = join(root, "old-shot.png");
  writeFileSync(oldShot, "OLDPNG");
  const lines: object[] = [];
  for (let i = 1; i <= 6; i++) {
    const content = i === 3 ? [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] : i === 1 ? `look ${oldShot}` : `q${i}`;
    lines.push({ type: "user", uuid: `u${i}`, message: { role: "user", content } });
    lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `a${i}` }] } });
  }
  writeFileSync(join(dir, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const herdr: HerdrLike = {
    getPane: async (id): Promise<PaneInfo> => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: "s", cwd, title: "t", workspaceId: "w1" }),
    listAgentPanes: async () => [],
    listWorkspaces: async () => [],
    readScreen: async () => "",
    sendText: async () => {},
    sendKeys: async () => {},
  };
  const made = createServer({
    herdr, token: TOKEN, attachmentsDir: join(root, "att"), projectsRoot: projects, uiDir, distDir: root,
    opener: async () => {}, stateDir, version: "9.9.9",
  });
  const port = Number(made.server.port);
  const b = `http://127.0.0.1:${port}`;
  afterAll(() => made.server.stop(true));
  const H = { cookie: `sidecr=${TOKEN}`, "content-type": "application/json" };
  const put = (body: unknown, headers: Record<string, string> = H) => fetch(`${b}/api/settings`, { method: "PUT", headers, body: JSON.stringify(body) });

  test("GET returns the settings, the schema to render from, and the About facts", async () => {
    const res = await fetch(`${b}/api/settings`, { headers: { cookie: `sidecr=${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: unknown; schema: { groups: unknown[]; settings: { id: string }[] }; about: { version: string; stateDir: string } };
    expect(body.settings).toEqual(defaultSettings());
    expect(body.schema.groups).toEqual(JSON.parse(JSON.stringify(GROUPS)));
    expect(body.schema.settings.map((d) => d.id)).toEqual(SCHEMA.map((d) => d.id));
    expect(body.about).toEqual({ version: "9.9.9", stateDir });
  });

  test("the same gates as the other endpoints", async () => {
    expect((await fetch(`${b}/api/settings`)).status).toBe(401);
    expect((await put({ strength: 1 }, { "content-type": "application/json" })).status).toBe(401);
    expect((await put({ strength: 1 }, { ...H, host: "evil.example" })).status).toBe(403);
    expect((await put({ strength: 1 }, { ...H, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await put({ strength: 1 }, { cookie: H.cookie, "content-type": "text/plain" })).status).toBe(415);
    expect((await fetch(`${b}/api/settings`, { method: "POST", headers: H, body: "{}" })).status).toBe(405);
    expect((await put([1, 2])).status).toBe(400);
    expect((await fetch(`${b}/api/settings`, { method: "PUT", headers: H, body: "{oops" })).status).toBe(400);
    expect(readSettings(stateDir)).toEqual(defaultSettings()); // none of these wrote anything
  });

  test("PUT validates per key, persists, returns the full result, and pushes a settings event to every stream", async () => {
    const ctl = new AbortController();
    const streams = await Promise.all(
      ["&win=aaaaaaaaaaaaaaaa", ""].map((q) => fetch(`${b}/api/events?pane=w1:p1${q}`, { headers: { cookie: `sidecr=${TOKEN}` }, signal: ctl.signal })),
    );
    const readers = streams.map((r) => {
      const reader = r.body!.getReader();
      const state = { text: "" };
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            state.text += new TextDecoder().decode(value);
          }
        } catch { /* aborted */ }
      })();
      return state;
    });
    await Bun.sleep(100);
    const res = await put({ strength: 25, effect: "plasma", alwaysOnTop: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown>; rejected: string[] };
    expect(body.settings).toEqual({ ...defaultSettings(), strength: 25, alwaysOnTop: false });
    expect(body.rejected).toEqual(["effect"]);
    expect(JSON.parse(readFileSync(join(stateDir, SETTINGS_FILE), "utf8"))).toEqual(body.settings);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !readers.every((r) => r.text.includes("event: settings"))) await Bun.sleep(20);
    for (const r of readers) {
      const m = /event: settings\ndata: (.*)\n\n/.exec(r.text);
      expect(m).not.toBeNull();
      expect(JSON.parse(m![1]!)).toEqual(body.settings);
    }
    // An update that changes nothing pushes nothing.
    const before = readers[0]!.text.split("event: settings").length;
    await put({ strength: 25 });
    await Bun.sleep(100);
    expect(readers[0]!.text.split("event: settings").length).toBe(before);
    ctl.abort();
  });

  test("going from 3 to 10 exchanges previews an older image at once (the allow-list memo follows the setting)", async () => {
    const file = () => fetch(`${b}/api/file?pane=w1:p1&path=${encodeURIComponent(oldShot)}`, { headers: { cookie: `sidecr=${TOKEN}` } });
    await put({ exchangesShown: 3 });
    expect((await file()).status).toBe(403); // exchange 1 is not shown; this also fills the 2 s memo
    await put({ exchangesShown: 10 });
    const res = await file();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OLDPNG");
    // Back to 3: the window may still show that exchange (it was handed out, and older blocks stay loaded), so the
    // session's allow-list keeps it. What was never handed out stays refused (the first 403 above).
    await put({ exchangesShown: 3 });
    expect((await file()).status).toBe(200);
  });

  test("exchangesShown sets how many exchanges the conversation returns", async () => {
    const count = async () => ((await (await fetch(`${b}/api/conversation?pane=w1:p1`, { headers: { cookie: `sidecr=${TOKEN}` } })).json()) as { exchanges: unknown[] }).exchanges.length;
    await put({ exchangesShown: 3 });
    expect(await count()).toBe(3);
    await put({ exchangesShown: 5 });
    expect(await count()).toBe(5);
    await put({ exchangesShown: 10 });
    expect(await count()).toBe(6); // all there is
  });

  test("/api/image serves an inline transcript image by exchange and block, with the file headers", async () => {
    await put({ exchangesShown: 10 });
    const ok = await fetch(`${b}/api/image?pane=w1:p1&ex=u3&block=u1`, { headers: { cookie: `sidecr=${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-security-policy")).toBe("sandbox");
    expect(await ok.text()).toBe("fake png bytes");
    const get = (q: string, headers: Record<string, string> = { cookie: `sidecr=${TOKEN}` }) => fetch(`${b}/api/image?${q}`, { headers });
    expect((await get("pane=w1:p1&ex=u3&block=u0")).status).toBe(404); // a text block
    expect((await get("pane=w1:p1&ex=u9&block=u1")).status).toBe(404);
    expect((await get("pane=w1:p1&ex=u3&block=x1")).status).toBe(400);
    expect((await get("pane=w1:p1&block=u1")).status).toBe(400);
    expect((await get("pane=w1:p1&ex=u3&block=u1", {})).status).toBe(401);
    // Any exchange of the session by id, not only the ones in the tail: the window may have loaded older blocks.
    await put({ exchangesShown: 3 });
    expect((await get("pane=w1:p1&ex=u3&block=u1")).status).toBe(200);
    expect((await get(`pane=w1:p1&ex=${"x".repeat(201)}&block=u1`)).status).toBe(400);
  });

  test("the lightbox page and its script need the cookie like everything else", async () => {
    expect((await fetch(`${b}/lightbox.html`)).status).toBe(401);
    const page = await fetch(`${b}/lightbox.html`, { headers: { cookie: `sidecr=${TOKEN}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const js = await fetch(`${b}/lightbox.js`, { headers: { cookie: `sidecr=${TOKEN}` } });
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe("//lb");
  });
});

describe("a server without a state directory", () => {
  test("keeps settings in memory and still answers", async () => {
    const root = fresh();
    const made = createServer({
      herdr: { getPane: async () => { throw new Error("x"); }, listAgentPanes: async () => [], listWorkspaces: async () => [], readScreen: async () => "", sendText: async () => {}, sendKeys: async () => {} },
      token: "t", attachmentsDir: root, uiDir: root, distDir: root, opener: async () => {},
    });
    const b = `http://127.0.0.1:${Number(made.server.port)}`;
    const H = { cookie: "sidecr=t", "content-type": "application/json" };
    const res = await fetch(`${b}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ textSize: "small" }) });
    expect(((await res.json()) as { settings: { textSize: string } }).settings.textSize).toBe("small");
    const got = (await (await fetch(`${b}/api/settings`, { headers: H })).json()) as { about: { stateDir: string; version: string } };
    expect(got.about).toEqual({ version: "", stateDir: "" });
    made.server.stop(true);
  });
});
