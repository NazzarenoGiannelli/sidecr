/**
 * Real-window screenshots of the invented demo: a throwaway Sidecr server fed by the stub herdr and the fixture
 * transcript, the TEST build of the native shell pointed at it, and the page driven over the WebView2 debug port.
 *
 *   bun demo/capture.ts            # writes demo/out/shots/<state>.png (2x, transparent where the window is)
 *
 * Only the page is captured (Page.captureScreenshot renders the page itself, never the screen). Safety: a throwaway
 * state dir (SIDECR_DEMO_STATE, default demo/out/state), a throwaway port (SIDECR_DEMO_PORT, default 47796), the test
 * shell only (shell/src-tauri/target-test, its own identifier), and every process started here is stopped at the end.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";
import { connectPage, settle, until, type Cdp } from "./cdp";
import { CWD, MACHINE, PANE, SESSION, stubHerdr } from "./stub-herdr";
import pkg from "../package.json";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "demo", "out", "shots");
const STATE = resolve(process.env.SIDECR_DEMO_STATE ?? join(ROOT, "demo", "out", "state"));
const PORT = Number(process.env.SIDECR_DEMO_PORT ?? 47796);
const DEBUG_PORT = Number(process.env.SIDECR_DEMO_DEBUG_PORT ?? 9370);
const SHELL = resolve(process.env.SIDECR_SHELL ?? join(ROOT, "shell", "src-tauri", "target-test", "release", process.platform === "win32" ? "sidecr-shell.exe" : "sidecr-shell"));
/** The window, in CSS pixels; shots are taken at twice that. */
const W = 540;
const H = 940;
const SCALE = 2;
/** What the About section shows instead of the throwaway folder. */
const SHOWN_STATE_DIR = "C:\\Users\\alice\\AppData\\Local\\herdr\\plugins\\nazz.sidecr";
const DRAFT = "Open the PR against main, title: Cursor pagination for /v1/orders";
/** Strings that must never appear in a shot (checked on the page text and attributes before each capture). */
const FORBIDDEN = [process.env.USERNAME, process.env.COMPUTERNAME, "scratchpad", "AppData\\Local\\Temp", "\\Temp\\"]
  .filter((s): s is string => !!s && s.length > 2 && s.toLowerCase() !== "alice")
  .map((s) => s.toLowerCase());

// ── Safety first ──────────────────────────────────────────────────────────────
const live = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "herdr", "plugins", "nazz.sidecr").toLowerCase() : "";
if (STATE.toLowerCase() === live || STATE.toLowerCase().startsWith(live + "\\")) throw new Error("refusing the live state directory");
if (PORT === 47631) throw new Error("refusing the live port 47631");
if (!/[\\/]target-test[\\/]/.test(SHELL)) throw new Error("SIDECR_SHELL must be a test build (target-test): the release shell shares the user's identifier");
if (!existsSync(SHELL)) throw new Error(`no test shell at ${SHELL}; run: bun run build:shell:test`);
if (!existsSync(join(ROOT, "dist", "app.js"))) throw new Error("the UI is not built; run: bun run build:ui");
if (process.platform === "win32") {
  // A second test shell would hand its address to one already open (single instance): never touch someone else's.
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "Get-Process sidecr-shell -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"]);
  const running = new TextDecoder().decode(r.stdout).split(/\r?\n/).filter((p) => /target-test/i.test(p));
  if (running.length) throw new Error(`a test shell is already running (${running.join(", ")}); close it first`);
}

const log = (m: string) => console.log(`[capture] ${m}`);

// ── The throwaway server ──────────────────────────────────────────────────────
rmSync(STATE, { recursive: true, force: true });
const projects = join(STATE, "projects");
mkdirSync(join(projects, encodeCwd(CWD)), { recursive: true });
copyFileSync(join(ROOT, "demo", "fixture", "session.jsonl"), join(projects, encodeCwd(CWD), `${SESSION}.jsonl`));
writeFileSync(join(STATE, "machine-name"), MACHINE);
const opened: string[] = [];
const token = crypto.randomUUID();
const { stop } = createServer({
  herdr: stubHerdr(),
  token,
  attachmentsDir: join(STATE, "attachments"),
  projectsRoot: projects,
  uiDir: join(ROOT, "ui"),
  distDir: join(ROOT, "dist"),
  opener: async (target) => {
    opened.push(target); // the demo never opens anything
  },
  stateDir: STATE,
  machineName: MACHINE,
  port: PORT,
  version: pkg.version,
});
log(`server on ${PORT}, state ${STATE}`);

// ── The window ────────────────────────────────────────────────────────────────
const url = `http://localhost:${PORT}/?t=${encodeURIComponent(token)}&pane=${encodeURIComponent(PANE)}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
  WEBVIEW2_USER_DATA_FOLDER: join(STATE, "webview"),
};
delete env.SIDECR_LAUNCHER;
delete env.HERDR_PANE_ID;
delete env.HERDR_PLUGIN_CONTEXT_JSON;
// No windowsHide: SW_HIDE would hide the shell's first window.
const shell = Bun.spawn([SHELL, "--url", url, "--x", "120", "--y", "60", "--w", String(W), "--h", String(H)], { env, stdio: ["ignore", "ignore", "ignore"] });
log(`test shell pid ${shell.pid}`);

async function cleanup(): Promise<void> {
  if (process.platform === "win32") {
    Bun.spawnSync([`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, "/PID", String(shell.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  }
  try {
    shell.kill();
  } catch {
    /* gone */
  }
  stop(true);
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(STATE, { recursive: true, force: true });
      break;
    } catch {
      await Bun.sleep(300); // WebView2 lets go of its folder a moment after the process ends
    }
  }
  log(existsSync(STATE) ? `could not delete ${STATE}` : "stopped the shell and the server, deleted the state");
}

// ── Driving the page ──────────────────────────────────────────────────────────
async function privacyCheck(cdp: Cdp, name: string): Promise<void> {
  const text = await cdp.eval<string>(`(() => {
    const parts = [document.body.innerText, document.title];
    for (const el of document.querySelectorAll("*")) for (const a of ["title", "href", "aria-label", "placeholder", "alt", "value"]) {
      const v = el.getAttribute(a); if (v) parts.push(v);
    }
    const m = document.getElementById("msg"); if (m) parts.push(m.value);
    return parts.join("\\n");
  })()`);
  const low = text.toLowerCase();
  const hit = FORBIDDEN.find((f) => low.includes(f));
  if (hit) throw new Error(`privacy check failed on ${name}: the page shows "${hit}"`);
}

async function shoot(cdp: Cdp, name: string): Promise<void> {
  await settle(cdp);
  await privacyCheck(cdp, name);
  const r = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const file = join(OUT, `${name}.png`);
  await Bun.write(file, Buffer.from(r.data, "base64"));
  log(`shot ${name}`);
}

async function escapeAll(cdp: Cdp): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await key(cdp, "Escape", "Escape", 27);
    await Bun.sleep(120);
  }
  await cdp.eval(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
}

async function key(cdp: Cdp, k: string, code: string, vk: number, modifiers = 0): Promise<void> {
  const base = { key: k, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Scrolls the conversation so that the element matching `selector` sits `offset` px from the top of the view. */
async function scrollTo(cdp: Cdp, selector: string, offset: number): Promise<void> {
  await cdp.eval(`(() => { const c = document.getElementById("conv"); const e = document.querySelector(${JSON.stringify(selector)});
    c.scrollTop = c.scrollTop + e.getBoundingClientRect().top - c.getBoundingClientRect().top - ${offset}; return true; })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const cdp = await connectPage(DEBUG_PORT, (u) => u.includes(`:${PORT}/`), 30_000);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // Deterministic: the same clock zone and language everywhere, a transparent page background (the acrylic is
  // emulated by the compositor), and the window's CSS size rendered at 2x.
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Rome" });
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => {});
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  // The settings panel's About section names the state folder: show an invented one.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/settings*", requestStage: "Response" }] });
  cdp.on("Fetch.requestPaused", async (p) => {
    try {
      if (p.request.method !== "GET" || !p.responseStatusCode) return void (await cdp.send("Fetch.continueRequest", { requestId: p.requestId }));
      const b = await cdp.send<{ body: string; base64Encoded: boolean }>("Fetch.getResponseBody", { requestId: p.requestId });
      const json = JSON.parse(b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body);
      if (json.about) json.about.stateDir = SHOWN_STATE_DIR;
      await cdp.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders, body: Buffer.from(JSON.stringify(json)).toString("base64") });
    } catch (e) {
      log(`settings rewrite failed: ${e}`);
    }
  });
  await cdp.eval(`(location.reload(), true)`);
  await Bun.sleep(800);
  await until(cdp, `document.documentElement.classList.contains("shell") && document.querySelectorAll("#conv .ex").length >= 5 && document.getElementById("title").textContent.includes("Cursor pagination")`, "the conversation");
  await until(cdp, `[...document.querySelectorAll("#conv img.thumb")].every((i) => i.complete && i.naturalWidth > 0)`, "the thumbnails");
  await cdp.eval(`document.fonts.ready.then(() => true)`);
  await settle(cdp, 900);

  // A draft in the composer (the send button lights up), without focus: no caret in the shot.
  await cdp.eval(`(() => { const m = document.getElementById("msg"); m.focus(); m.value = ${JSON.stringify(DRAFT)}; m.dispatchEvent(new Event("input", { bubbles: true })); m.blur(); return true; })()`);
  await cdp.eval(`(() => { const c = document.getElementById("conv"); c.scrollTop = c.scrollHeight; return true; })()`);
  await shoot(cdp, "conversation");

  // The last reply's tool calls unfolded.
  await cdp.eval(`(() => { const d = [...document.querySelectorAll("#conv details.tools")].at(-1); d.open = true; const c = document.getElementById("conv"); c.scrollTop = c.scrollHeight; return true; })()`);
  await shoot(cdp, "conversation-tools");
  await cdp.eval(`(() => { const d = [...document.querySelectorAll("#conv details.tools")].at(-1); d.open = false; return true; })()`);

  // The pointer over the folder link (the hover state; the native tooltip is not part of the page).
  await cdp.eval(`(() => { const c = document.getElementById("conv"); c.scrollTop = c.scrollHeight; return true; })()`);
  await settle(cdp);
  const at = await cdp.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = [...document.querySelectorAll("#conv a.link.dir")].at(-1).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + at.w * 0.6, y: at.y + at.h / 2 });
  writeFileSync(join(OUT, "folder-link.json"), JSON.stringify({ ...at, pointer: { x: at.x + at.w * 0.6, y: at.y + at.h / 2 }, scale: SCALE }));
  await shoot(cdp, "folder-hover");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W - 4, y: 4 });

  // Media & links: images, then links.
  await cdp.eval(`(document.getElementById("media").click(), true)`);
  await until(cdp, `!document.getElementById("media-layer").hidden && document.querySelectorAll("#media-layer img").length >= 6`, "the media panel");
  await until(cdp, `[...document.querySelectorAll("#media-layer img")].every((i) => i.complete && i.naturalWidth > 0)`, "the media thumbnails");
  await until(cdp, `!/Indexing/.test(document.querySelector("#media-layer .media-note")?.textContent ?? "")`, "the media index", 20_000);
  await cdp.eval(`(document.activeElement && document.activeElement.blur(), true)`);
  await shoot(cdp, "media");
  await cdp.eval(`([...document.querySelectorAll("#media-layer .media-tab")][1].click(), true)`);
  await until(cdp, `document.querySelectorAll("#media-layer .media-link").length >= 4`, "the links tab");
  await cdp.eval(`(document.activeElement && document.activeElement.blur(), true)`);
  await shoot(cdp, "media-links");
  await escapeAll(cdp);

  // Settings (the Appearance group, Acrylic) and the shortcuts.
  await cdp.eval(`(document.getElementById("gear").click(), true)`);
  await until(cdp, `!document.getElementById("settings").hidden && document.querySelector("#settings .set-group")`, "the settings");
  await cdp.eval(`(document.activeElement && document.activeElement.blur(), true)`);
  await shoot(cdp, "settings");
  await escapeAll(cdp);
  await cdp.eval(`(document.getElementById("keys-hint").click(), true)`);
  await until(cdp, `!document.getElementById("cheatsheet").hidden && document.querySelector("#cheatsheet .cheat-row")`, "the shortcuts");
  await cdp.eval(`(document.activeElement && document.activeElement.blur(), true)`);
  await shoot(cdp, "shortcuts");
  await escapeAll(cdp);

  // The lightbox on the latest picture.
  await cdp.eval(`(() => { const c = document.getElementById("conv"); c.scrollTop = c.scrollHeight; [...document.querySelectorAll("#conv img.thumb")].at(-1).click(); return true; })()`);
  await until(cdp, `!document.getElementById("lightbox").hidden`, "the lightbox");
  await cdp.eval(`(document.activeElement && document.activeElement.blur && document.activeElement !== document.body && document.activeElement.blur(), true)`);
  await shoot(cdp, "lightbox");
  await escapeAll(cdp);
  // Leave nothing behind: the draft (a drafts.json in the throwaway folder, deleted with it anyway).
  cdp.close();
  if (opened.length) log(`(nothing should have opened, but: ${opened.join(", ")})`);
}

try {
  await main();
} finally {
  await cleanup();
}
