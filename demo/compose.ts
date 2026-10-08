/**
 * The release images, composed from the real-window shots (demo/out/shots, from capture.ts) and the current logo
 * (docs/brand/sidecr-icon.svg), laid out in HTML and rendered by a headless Chromium (Edge, Chrome or Chromium) with
 * its own throwaway profile. No network: fonts are the system's, images are local files.
 *
 *   bun demo/compose.ts      # docs/media/hero.png, social-preview.png, shot-*.png, preview-sheet.png
 *
 * The terminal on the left of the hero is DRAWN here (an invented herdr session), never captured. The window's
 * acrylic cannot be captured either: the shots are transparent where the page is, and the acrylic is emulated under
 * them (the drawn backdrop blurred and tinted with CSS backdrop-filter).
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { systemBrowser } from "../src/browser";
import { connectPage, settle, until } from "./cdp";
import { TERMINAL_CSS, terminalHtml } from "./terminal";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = join(ROOT, "demo", "out", "shots");
const WORK = join(ROOT, "demo", "out", "compose");
const MEDIA = join(ROOT, "docs", "media");
const LOGO = join(ROOT, "docs", "brand", "sidecr-icon.svg");
const DEBUG_PORT = Number(process.env.SIDECR_DEMO_COMPOSE_PORT ?? 9371);

export const TAGLINE = "A companion window for herdr. Summon it, reply, dismiss.";
export const INSTALL = "herdr plugin install NazzarenoGiannelli/sidecr";

const url = (p: string) => pathToFileURL(p).href;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The window's CSS size at capture (the shots are 2x). */
const CAP_W = 540;
const CAP_H = 940;

// ── Shared look ───────────────────────────────────────────────────────────────
const FONTS = `
  --ui: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --head: "Inter", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrains Mono", "Cascadia Mono", Consolas, monospace;`;

const NOISE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
)}")`;

const BASE_CSS = `
  :root { ${FONTS} --accent: #5347fd; --accent-text: #9a92ff; --fg: #ececec; --muted: #a6a6a6; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0b0c10; color: var(--fg); -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
  body { position: relative; overflow: hidden; font-family: var(--ui); }
  .noise { position: absolute; inset: 0; background-image: ${NOISE}; opacity: 0; mix-blend-mode: overlay; pointer-events: none; }
  .brand { display: flex; align-items: center; }
  .brand img { display: block; }
  .brand .name { font-family: var(--head); font-weight: 700; letter-spacing: -.035em; color: #f5f5f7; font-feature-settings: "ss01", "cv11"; }
  .tagline { font-family: var(--head); font-weight: 500; color: #a9a9b6; letter-spacing: -.012em; }
  .install { font-family: var(--mono); color: #8d8d99; letter-spacing: 0; }
  .install b { color: var(--accent-text); font-weight: 500; margin-right: .6em; }
  /* The Sidecr window: the real page (transparent where its surfaces are translucent) over an emulated acrylic. */
  .win { position: absolute; border-radius: var(--r); overflow: hidden; isolation: isolate;
    box-shadow: 0 0 0 1px #00000066, 0 2px 6px #0000004d, 0 30px 70px #00000080, 0 70px 160px #0000008c; }
  .win .acrylic { position: absolute; inset: 0; z-index: 0; background: rgba(26, 26, 30, .30);
    backdrop-filter: blur(var(--blur)) saturate(170%) brightness(1.1); -webkit-backdrop-filter: blur(var(--blur)) saturate(170%) brightness(1.1); }
  .win .acrylic::after { content: ""; position: absolute; inset: 0; background-image: ${NOISE}; opacity: .045; mix-blend-mode: overlay; }
  .win img.page { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; display: block; }
`;

function windowHtml(shot: string, x: number, y: number, w: number): string {
  const h = Math.round((w * CAP_H) / CAP_W);
  const s = w / CAP_W; // CSS px of the window -> px here
  return `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--r:${Math.round(8 * s)}px;--blur:${Math.round(30 * s)}px">
    <div class="acrylic"></div><img class="page" src="${url(join(SHOTS, `${shot}.png`))}" alt=""></div>`;
}

const HERO_BG = `
  .bg { position: absolute; inset: 0;
    background:
      radial-gradient(1150px 900px at 1900px 640px, rgba(83, 71, 253, .30), rgba(83, 71, 253, .08) 45%, transparent 72%),
      radial-gradient(1300px 820px at 260px 60px, rgba(140, 150, 190, .12), transparent 70%),
      radial-gradient(900px 600px at 900px 1350px, rgba(60, 70, 120, .16), transparent 70%),
      linear-gradient(180deg, #0d0e13, #0a0a0e); }
`;

// ── Pages ─────────────────────────────────────────────────────────────────────
interface Page {
  name: string;
  w: number;
  h: number;
  html: string;
}

/** Where things sit in the hero (px). The terminal runs off the left and bottom edges; the window floats over its right part. */
const WIN = { x: 1580, y: 290, w: 560 };
const TERM = { x: -20, y: 470, w: 2030, h: 920, fs: 19, padX: 28, padY: 8 };

const LABEL_CSS = `
  .label { position: absolute; font-family: var(--head); font-size: 21px; font-weight: 500; letter-spacing: -.005em; color: #e2e2ea;
    background: #191a22f0; border: 1px solid #ffffff2b; border-radius: 999px; padding: 7px 18px 8px; white-space: nowrap;
    box-shadow: 0 6px 20px #00000059; }
  .leader { position: absolute; width: 1.5px; background: linear-gradient(#ffffff70, #ffffff40); }
  .leader::after { content: ""; position: absolute; left: -3.5px; bottom: -4px; width: 8px; height: 8px; border-radius: 50%; background: #e2e2ea; box-shadow: 0 0 0 3px #ffffff1f; }
`;

/** The hero. `scene`: only the backdrop and the terminal (the social preview crops it). `annotated`: two labels. */
function hero(variant: "hero" | "scene" | "annotated"): Page {
  const W = 2400;
  const H = 1350;
  const scene = variant === "scene";
  const text = scene
    ? ""
    : `<div class="brand" style="position:absolute;left:150px;top:92px;gap:34px">
        <img src="${url(LOGO)}" width="132" height="132" alt=""><span class="name" style="font-size:136px;line-height:1">Sidecr</span></div>
       <div class="tagline" style="position:absolute;left:152px;top:254px;font-size:46px;line-height:1.25">${esc(TAGLINE)}</div>
       <div class="install" style="position:absolute;left:153px;top:338px;font-size:24px;line-height:1.3"><b>$</b>${esc(INSTALL)}</div>`;
  const labels =
    variant === "annotated"
      ? `<div class="label" style="left:1000px;top:404px">your terminal, as always</div>
         <div class="leader" style="left:1130px;top:446px;height:${TERM.y - 446 - 4}px"></div>
         <div class="label" style="right:${W - (WIN.x + WIN.w)}px;top:212px">Sidecr, the chat on the side</div>
         <div class="leader" style="left:${WIN.x + WIN.w - 150}px;top:254px;height:${WIN.y - 254 - 4}px"></div>`
      : "";
  return {
    name: variant === "hero" ? "hero" : variant === "scene" ? "hero-scene" : "hero-annotated",
    w: W,
    h: H,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${TERMINAL_CSS}${HERO_BG}${LABEL_CSS}</style></head><body style="width:${W}px;height:${H}px">
      <div class="bg"></div>
      ${terminalHtml(TERM.x, TERM.y, TERM.w, TERM.h, TERM.fs, TERM.padX, TERM.padY)}
      ${text}
      ${scene ? "" : windowHtml("conversation", WIN.x, WIN.y, WIN.w)}
      ${labels}
      <div class="noise"></div>
    </body></html>`,
  };
}

function social(): Page {
  const W = 1280;
  const H = 640;
  // A piece of the hero's terminal (its Claude Code pane), scaled, faded in from the left and running off the right
  // and bottom edges; the window floats over its right part, unfaded.
  const k = 0.56;
  const sx = 560; // hero px where the crop starts
  const sy = 466;
  const cropW = 640;
  const cropTop = 140;
  const win = { x: 880, y: 46, w: 318 };
  return {
    name: "social-preview",
    w: W,
    h: H,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      .crop { position: absolute; left: ${W - cropW}px; top: ${cropTop}px; width: ${cropW}px; height: ${H - cropTop}px; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.45) 22%, #000 48%); mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.45) 22%, #000 48%); }
      .crop img { position: absolute; left: ${-Math.round(sx * k)}px; top: ${-Math.round(sy * k)}px; width: ${2400 * k}px; height: ${1350 * k}px; }
    </style></head><body style="width:${W}px;height:${H}px">
      <div class="crop"><img src="${url(join(WORK, "hero-scene.png"))}" alt=""></div>
      ${windowHtml("conversation", win.x, win.y, win.w)}
      <div class="brand" style="position:absolute;left:72px;top:150px;gap:22px"><img src="${url(LOGO)}" width="92" height="92" alt=""><span class="name" style="font-size:94px;line-height:1">Sidecr</span></div>
      <div class="tagline" style="position:absolute;left:74px;top:282px;width:560px;font-size:36px;line-height:1.3">${TAGLINE.split(". ").map(esc).join(".<br>")}</div>
      <div class="install" style="position:absolute;left:74px;top:552px;font-size:17.5px"><b>$</b>${esc(INSTALL)}</div>
      <div class="noise"></div>
    </body></html>`,
  };
}

/** One real-window shot on a plain dark background, 1:1 (the 2x capture), with a hairline and a soft shadow. */
function shotPage(shot: string): Page {
  const winW = CAP_W * 2;
  const winH = CAP_H * 2;
  const W = 1600;
  const padY = 150;
  const H = winH + padY * 2;
  return {
    name: `shot-${shot}`,
    w: W,
    h: H,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      .bg { position: absolute; inset: 0; background: radial-gradient(900px 1200px at 50% 45%, #17181f, #0c0d11 70%); }
      .win .acrylic { background: rgba(34, 34, 38, .9); backdrop-filter: none; }
    </style></head><body style="width:${W}px;height:${H}px">
      <div class="bg"></div>
      <div class="win" style="left:${(W - winW) / 2}px;top:${padY}px;width:${winW}px;height:${winH}px;--r:16px;--blur:0px">
        <div class="acrylic"></div><img class="page" src="${url(join(SHOTS, `${shot}.png`))}" alt=""></div>
    </body></html>`,
  };
}

const SHOT_NAMES = ["conversation", "media", "settings", "shortcuts", "lightbox"] as const;

function sheet(sizes: Record<string, number>): Page {
  const W = 2400;
  const H = 1830;
  const kb = (n: string) => `${Math.round((sizes[n] ?? 0) / 1024)} KB`;
  const tile = (file: string, label: string, w: number) =>
    `<figure style="width:${w}px"><img src="${url(join(MEDIA, file))}" style="width:${w}px" alt=""><figcaption>${esc(label)}<span>${kb(file)}</span></figcaption></figure>`;
  return {
    name: "preview-sheet",
    w: W,
    h: H,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      body { padding: 60px; background: #121317; }
      h1 { font-family: var(--head); font-size: 34px; font-weight: 600; color: #f0f0f4; margin-bottom: 28px; letter-spacing: -.01em; }
      .row { display: flex; gap: 40px; align-items: flex-start; margin-bottom: 40px; }
      figure img { display: block; border-radius: 10px; box-shadow: 0 0 0 1px #ffffff14; }
      figcaption { display: flex; justify-content: space-between; margin-top: 12px; font-size: 20px; color: #c4c4cc; font-family: var(--mono); }
      figcaption span { color: #7c7c88; }
    </style></head><body style="width:${W}px;height:${H}px">
      <h1>Sidecr release images</h1>
      <div class="row">${tile("hero.png", "hero.png", 1520)}<div style="display:flex;flex-direction:column;gap:30px">${tile("social-preview.png", "social-preview.png", 720)}${tile("hero-annotated.png", "hero-annotated.png", 720)}</div></div>
      <div class="row" style="gap:36px">${SHOT_NAMES.map((n) => tile(`shot-${n}.png`, `shot-${n}.png`, 427)).join("")}</div>
    </body></html>`,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  for (const n of ["conversation", ...SHOT_NAMES]) {
    if (!existsSync(join(SHOTS, `${n}.png`))) throw new Error(`missing ${n}.png in demo/out/shots: run bun demo/capture.ts first`);
  }
  if (!existsSync(LOGO)) throw new Error(`missing the logo ${LOGO}`);
  const browser = process.env.SIDECR_DEMO_BROWSER ?? systemBrowser();
  if (!browser) throw new Error("no Chromium-family browser found (set SIDECR_DEMO_BROWSER)");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });
  const profile = join(WORK, "profile");
  rmSync(profile, { recursive: true, force: true });
  const proc = Bun.spawn(
    [browser, "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--hide-scrollbars",
      "--force-color-profile=srgb", "--force-device-scale-factor=1", "--mute-audio", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    const cdp = await connectPage(DEBUG_PORT, (u) => u === "about:blank" || u.startsWith("file:"), 20_000);
    await cdp.send("Page.enable");
    const render = async (p: Page, out: string) => {
      const file = join(WORK, `${p.name}.html`);
      await Bun.write(file, p.html);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: p.w, height: p.h, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.navigate", { url: url(file) });
      await until(cdp, `document.readyState === "complete" && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`, `${p.name} to load`);
      await cdp.eval(`document.fonts.ready.then(() => true)`);
      await settle(cdp, 300);
      const r = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: p.w, height: p.h, scale: 1 } });
      await Bun.write(out, Buffer.from(r.data, "base64"));
      console.log(`[compose] ${p.name} ${p.w}x${p.h}`);
    };
    await render(hero("scene"), join(WORK, "hero-scene.png"));
    await render(hero("hero"), join(MEDIA, "hero.png"));
    await render(hero("annotated"), join(MEDIA, "hero-annotated.png"));
    await render(social(), join(MEDIA, "social-preview.png"));
    for (const n of SHOT_NAMES) await render(shotPage(n), join(MEDIA, `shot-${n}.png`));
    // Optimise before the sheet, so it can show the final sizes.
    const opt = Bun.spawnSync(["python", join(ROOT, "demo", "optimize.py"), MEDIA], { stdout: "inherit", stderr: "inherit" });
    if (opt.exitCode !== 0) throw new Error("optimize.py failed");
    const sizes: Record<string, number> = {};
    for (const f of ["hero.png", "hero-annotated.png", "social-preview.png", ...SHOT_NAMES.map((n) => `shot-${n}.png`)]) sizes[f] = statSync(join(MEDIA, f)).size;
    await render(sheet(sizes), join(MEDIA, "preview-sheet.png"));
    Bun.spawnSync(["python", join(ROOT, "demo", "optimize.py"), "--min-psnr", "36", MEDIA, "preview-sheet.png"], { stdout: "inherit", stderr: "inherit" });
    cdp.close();
  } finally {
    proc.kill();
    await proc.exited;
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(300);
      }
    }
  }
}

if (import.meta.main) await main();
