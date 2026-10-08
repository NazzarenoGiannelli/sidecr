import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { createServer, decodeCursor, encodeCursor } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";
import { synthRows, toJsonl } from "./synthetic";

const TOKEN = "tok-media";
const root = mkdtempSync(join(tmpdir(), "sidecr-mediaep-"));
const projects = join(root, "projects");
const CWD = join(root, "work");
const dir = join(projects, encodeCwd(CWD));
mkdirSync(dir, { recursive: true });
const oldShot = join(root, "old-shot.png");
writeFileSync(oldShot, "OLDPNG");
const notes = join(root, "notes.md");
writeFileSync(notes, "# notes");
const PNG = Buffer.from("fake png").toString("base64");
const head = [
  JSON.stringify({ type: "user", uuid: "h1", timestamp: "2026-10-01T08:00:00.000Z", message: { role: "user", content: `first ${oldShot} and ${notes}, see https://Docs.Example.com/start#top` } }),
  JSON.stringify({ type: "user", uuid: "h2", timestamp: "2026-10-01T08:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "pasted" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] } }),
  JSON.stringify({ type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "The [start page](https://docs.example.com/start) again." }] } }),
];
const rows = [...head, ...synthRows(1500, { seed: 51, urls: ["https://example.com/a", "https://bun.sh/docs"] })];
writeFileSync(join(dir, "media.jsonl"), toJsonl(rows));

const herdr: HerdrLike = {
  getPane: async (id): Promise<PaneInfo> => ({ paneId: id, agent: "claude", agentStatus: "idle", sessionId: "media", cwd: CWD, title: "t", workspaceId: "w1" }),
  listAgentPanes: async () => [],
  listWorkspaces: async () => [],
  readScreen: async () => "",
  sendText: async () => {},
  sendKeys: async () => {},
};
const opened: string[] = [];
const made = createServer({ herdr, token: TOKEN, attachmentsDir: join(root, "att"), projectsRoot: projects, uiDir: root, distDir: root, opener: async (t) => { opened.push(t); } });
const base = `http://127.0.0.1:${Number(made.server.port)}`;
const H = { cookie: `sidecr=${TOKEN}` };
afterAll(() => made.server.stop(true));

interface Body {
  kind: string;
  items: any[];
  next: string | null;
  progress: number;
  complete: boolean;
  total: number;
  error?: string;
}
const media = async (q: string, headers: Record<string, string> = H, method = "GET") => {
  const res = await fetch(`${base}/api/media?pane=w1:p1${q}`, { headers, method });
  return { status: res.status, body: (await res.json()) as Body };
};
async function everything(kind: "images" | "links") {
  let b: Body;
  for (let i = 0; i < 500; i++) {
    b = (await media(`&kind=${kind}&limit=1`)).body;
    if (b.complete) break;
    await Bun.sleep(5);
  }
  const items: any[] = [];
  let next: string | null = null;
  do {
    const r = await media(`&kind=${kind}&limit=7${next ? `&cursor=${next}` : ""}`);
    expect(r.status).toBe(200);
    items.push(...r.body.items);
    next = r.body.next;
  } while (next);
  return items;
}

describe("cursor encoding", () => {
  test("round trip, and anything else is refused", () => {
    const c = { e: 3, o: 12345, q: 2, n: "https://x.example/" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ e: 1, o: 2, q: 3 }))).toEqual({ e: 1, o: 2, q: 3 });
    for (const bad of ["", "!!", "x".repeat(5000), Buffer.from("[1,2]").toString("base64url"), Buffer.from('{"e":-1,"o":0,"q":0}').toString("base64url"), Buffer.from('{"e":1,"o":0.5,"q":0}').toString("base64url")]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe("GET /api/media", () => {
  test("the gates: cookie, Host, Sec-Fetch-Site, GET only", async () => {
    expect((await media("&kind=links", {})).status).toBe(401);
    expect((await media("&kind=links", { ...H, host: "evil.example" })).status).toBe(403);
    expect((await media("&kind=links", { ...H, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await media("&kind=links", { ...H, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await media("&kind=links", H, "POST")).status).toBe(405);
  });

  test("bad parameters are a 400 with {error}", async () => {
    for (const q of ["", "&kind=videos", "&kind=links&limit=lots", "&kind=links&cursor=%21%21"]) {
      const r = await media(q);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad-request");
    }
    expect((await fetch(`${base}/api/media?kind=links`, { headers: H })).status).toBe(400); // no pane
  });

  test("links: deduplicated by normalised URL, first exchange kept, data only", async () => {
    const links = await everything("links");
    const start = links.find((l) => l.url.toLowerCase().startsWith("https://docs.example.com/start"));
    expect(start).toMatchObject({ host: "docs.example.com", count: 2, exchangeId: "h1", at: "2026-10-01T08:00:00.000Z" });
    expect(new Set(links.map((l) => l.url.toLowerCase().replace(/#.*/, ""))).size).toBe(links.length);
    for (const l of links) expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(["count", "exchangeId", "host", "url"]));
    for (const l of links) expect("href" in l).toBe(false);
    // Opening goes through /api/open like any link.
    const res = await fetch(`${base}/api/open`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ pane: "w1:p1", kind: "url", target: start.url }) });
    expect(res.status).toBe(200);
    expect(opened).toEqual([start.url]);
  });

  test("images: the /api/image or /api/file URL the window would use, and both serve, even far beyond the tail", async () => {
    const images = await everything("images");
    const block = images.find((i) => i.exchangeId === "h2" && i.kind === "block");
    expect(block).toMatchObject({ i: 1, src: "/api/image?pane=w1%3Ap1&ex=h2&block=u1" });
    expect(block.thumb).toBe(block.src);
    const shot = images.find((i) => i.kind === "path" && i.exchangeId === "h1");
    expect(shot.src).toBe(`/api/file?pane=w1%3Ap1&path=${encodeURIComponent(oldShot)}`);
    // Not an image: never listed.
    expect(images.some((i) => i.src.includes(encodeURIComponent(notes)))).toBe(false);
    const a = await fetch(`${base}${block.src}`, { headers: H });
    expect(a.status).toBe(200);
    expect(a.headers.get("content-security-policy")).toBe("sandbox");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    const f = await fetch(`${base}${shot.src}`, { headers: H });
    expect(f.status).toBe(200);
    expect(await f.text()).toBe("OLDPNG");
    // A path no exchange mentions is still refused.
    expect((await fetch(`${base}/api/file?pane=w1:p1&path=${encodeURIComponent(join(root, "secret.png"))}`, { headers: H })).status).toBe(403);
  });

  test("limit is clamped to 1..100 and pages follow the cursor without repeats", async () => {
    const big = await media("&kind=links&limit=1000");
    expect(big.body.items.length).toBeLessThanOrEqual(100);
    const one = await media("&kind=links&limit=0");
    expect(one.body.items.length).toBe(1);
    const p1 = await media("&kind=links&limit=2");
    const p2 = await media(`&kind=links&limit=2&cursor=${p1.body.next}`);
    expect(p2.body.items.map((x) => x.url)).not.toContain(p1.body.items[0].url);
  });

  test("a cursor from before the file was replaced is a 410", async () => {
    const p1 = await media("&kind=links&limit=1");
    writeFileSync(join(dir, "media.jsonl"), toJsonl(synthRows(50, { seed: 52, urls: ["https://example.com/z"] })));
    const r = await media(`&kind=links&limit=1&cursor=${p1.body.next}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("stale-cursor");
    writeFileSync(join(dir, "media.jsonl"), toJsonl(rows)); // back, for any later test
  });
});
