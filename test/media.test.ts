import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory, MAX_LINKS, MAX_MEDIA, type MediaCursor, type MediaImage, type MediaLink, type MediaPage } from "../src/transcript/history";
import { collectMedia, normaliseUrl, titleAround } from "../src/transcript/media";
import { parseTranscript, type Exchange } from "../src/transcript/parse";
import { fsTranscriptReader } from "../src/transcript/reader";
import { synthRows, toJsonl } from "./synthetic";

const dir = mkdtempSync(join(tmpdir(), "sidecr-media-"));
let n = 0;
const file = (content: string) => {
  const p = join(dir, `m${++n}.jsonl`);
  writeFileSync(p, content);
  return p;
};
const ex = (user: Exchange["user"], assistant: Exchange["assistant"] = []): Exchange => ({ id: "x", user, assistant });

describe("collectMedia", () => {
  test("image blocks, image paths in user and assistant text, nothing else", () => {
    const m = collectMedia(
      ex(
        [{ kind: "text", text: "see C:\\shots\\a.png and /tmp/notes.md" }, { kind: "image", dataUrl: "data:image/png;base64,AAAA" }],
        [{ kind: "text", text: "saved `~/out/b.webp`." }],
      ),
    );
    expect(m.images).toEqual([{ kind: "path", path: "C:\\shots\\a.png" }, { kind: "block", block: 1 }, { kind: "path", path: "~/out/b.webp" }]);
  });

  test("links: trailing punctuation off, Markdown links, URLs inside code, every mention counted", () => {
    const m = collectMedia(
      ex(
        [{ kind: "text", text: "Read https://Example.com/a, then (https://example.com/b)." }],
        [
          { kind: "text", text: "The [Bun docs](https://bun.sh/docs#install) say so.\n```\ncurl https://example.com/a\n```" },
          { kind: "tools", count: 2, items: [{ name: "WebFetch", summary: "https://news.example.org/x" }, { name: "WebFetch", summary: "https://cut.example.org/very/long…" }] },
        ],
      ),
    );
    expect(m.links.map((l) => l.url)).toEqual(["https://Example.com/a", "https://example.com/b", "https://bun.sh/docs#install", "https://example.com/a", "https://news.example.org/x"]);
    expect(m.links.map((l) => l.norm)).toEqual(["https://example.com/a", "https://example.com/b", "https://bun.sh/docs", "https://example.com/a", "https://news.example.org/x"]);
    expect(m.links[2]!.title).toBe("Bun docs");
    expect(m.links[0]!.title).toBe("Read");
    expect(m.links[4]!.title).toBe("WebFetch");
    expect(m.links[0]!.host).toBe("example.com");
  });

  test("normaliseUrl and titles", () => {
    expect(normaliseUrl("HTTPS://EXAMPLE.com:443/Path?q=1#frag")).toEqual({ norm: "https://example.com/Path?q=1", host: "example.com" });
    expect(normaliseUrl("ftp://x.example")).toBeNull();
    expect(normaliseUrl("not a url")).toBeNull();
    const t = "Here is the **release notes** page: https://x.example/r";
    expect(titleAround(t, t.indexOf("https"), t.length)).toBe("Here is the release notes page");
    const after = "https://x.example/r is the page";
    expect(titleAround(after, 0, after.indexOf(" "))).toBe("is the page");
    expect(titleAround("https://x.example", 0, 17)).toBeUndefined();
  });
});

async function allPages(h: ReturnType<typeof createHistory>, f: string, kind: "images" | "links", limit: number) {
  // Wait for the background indexing to finish, then page through everything.
  for (let i = 0; i < 500; i++) {
    const p = (await h.media(f, { kind, cursor: null, limit })) as MediaPage;
    if (p.complete) break;
    await Bun.sleep(5);
  }
  const items: (MediaImage | MediaLink)[] = [];
  let cursor: MediaCursor | null = null;
  let pages = 0;
  for (;;) {
    const p = (await h.media(f, { kind, cursor, limit })) as MediaPage;
    expect(p.complete).toBe(true);
    items.push(...((kind === "images" ? p.images : p.links) ?? []));
    pages++;
    if (!p.next) break;
    cursor = p.next;
  }
  return { items, pages };
}

describe("the media index", () => {
  const urls = ["https://example.com/a", "https://example.com/b", "https://bun.sh/docs", "https://news.example.org/x"];
  const paths = ["C:\\shots\\one.png", "/home/me/two.webp", "C:\\shots\\three.jpg"];

  test("links: deduplicated, counted, first exchange kept, newest first mention first, pages without gaps or repeats", async () => {
    const lines = synthRows(3000, { seed: 41, urls, paths });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 16 * 1024 });
    const { items, pages } = await allPages(h, f, "links", 2);
    expect(pages).toBeGreaterThan(1);
    const links = items as MediaLink[];
    // Expected from the full parse.
    const full = parseTranscript(lines, Number.MAX_SAFE_INTEGER);
    const want = new Map<string, { count: number; first: string }>();
    for (const e of full) {
      for (const l of collectMedia(e).links) {
        const w = want.get(l.norm);
        if (w) w.count++;
        else want.set(l.norm, { count: 1, first: e.id });
      }
    }
    expect(links.length).toBe(want.size);
    expect(new Set(links.map((l) => l.norm)).size).toBe(links.length);
    for (const l of links) {
      expect(l.count).toBe(want.get(l.norm)!.count);
      expect(l.exchangeId).toBe(want.get(l.norm)!.first);
    }
    // Newest first by the first mention: a later mention never moves a link (the panel's cursor never skips it).
    for (let i = 1; i < links.length; i++) expect(links[i - 1]!.firstOffset).toBeGreaterThanOrEqual(links[i]!.firstOffset);
  });

  test("images: every block, each path once (its newest mention), newest first", async () => {
    const lines = synthRows(3000, { seed: 42, paths });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 16 * 1024 });
    const { items } = await allPages(h, f, "images", 25);
    const images = items as MediaImage[];
    const full = parseTranscript(lines, Number.MAX_SAFE_INTEGER);
    const blocks = full.reduce((c, e) => c + e.user.filter((b) => b.kind === "image").length, 0);
    expect(images.filter((i) => i.kind === "block").length).toBe(blocks);
    const pathItems = images.filter((i) => i.kind === "path");
    expect(pathItems.map((i) => i.path).sort()).toEqual([...paths].filter((p) => full.some((e) => collectMedia(e).images.some((x) => x.path === p))).sort());
    // The newest mention of each path.
    for (const it of pathItems) {
      const newest = [...full].reverse().find((e) => collectMedia(e).images.some((x) => x.path === it.path))!;
      expect(it.exchangeId).toBe(newest.id);
    }
    for (let i = 1; i < images.length; i++) {
      const a = images[i - 1]!;
      const b = images[i]!;
      expect(a.offset > b.offset || (a.offset === b.offset && a.seq > b.seq)).toBe(true);
    }
    // The panel shows the paths through /api/file: they are in the allow-list now.
    for (const p of paths) if (pathItems.some((i) => i.path === p)) expect(h.paths(f).has(p)).toBe(true);
  });

  test("a first page answers before the whole file is indexed, with the progress so far", async () => {
    const lines = synthRows(40_000, { seed: 43, urls });
    const f = file(toJsonl(lines));
    const h = createHistory({ reader: fsTranscriptReader, chunkBytes: 8 * 1024 });
    const first = (await h.media(f, { kind: "links", cursor: null, limit: 3 })) as MediaPage;
    expect(first.complete).toBe(false);
    expect(first.progress).toBeGreaterThan(0);
    expect(first.progress).toBeLessThan(1);
    let last = first;
    for (let i = 0; i < 2000 && !last.complete; i++) {
      await Bun.sleep(2);
      last = (await h.media(f, { kind: "links", cursor: null, limit: 3 })) as MediaPage;
      expect(last.progress).toBeGreaterThanOrEqual(first.progress);
    }
    expect(last.complete).toBe(true);
    expect(last.progress).toBe(1);
  }, 30_000);

  test("the open (last) exchange shows at once, and stays once it closes", async () => {
    const f = file(toJsonl(synthRows(200, { seed: 44 })));
    const h = createHistory({ reader: fsTranscriptReader });
    await h.media(f, { kind: "links", cursor: null, limit: 10 });
    appendFileSync(f, `${JSON.stringify({ type: "user", uuid: "live", message: { role: "user", content: "look https://live.example/now and C:\\shots\\live.png" } })}\n`);
    const a = (await h.media(f, { kind: "links", cursor: null, limit: 10 })) as MediaPage;
    expect(a.links![0]).toMatchObject({ norm: "https://live.example/now", exchangeId: "live", count: 1 });
    const imgs = (await h.media(f, { kind: "images", cursor: null, limit: 10 })) as MediaPage;
    expect(imgs.images![0]).toMatchObject({ kind: "path", path: "C:\\shots\\live.png", exchangeId: "live" });
    // Claude mentions it again in the same, still open exchange; then a new prompt closes it.
    appendFileSync(f, `${JSON.stringify({ type: "assistant", message: { id: "z", role: "assistant", content: [{ type: "text", text: "yes, https://live.example/now" }] } })}\n`);
    expect(((await h.media(f, { kind: "links", cursor: null, limit: 10 })) as MediaPage).links![0]!.count).toBe(2);
    appendFileSync(f, `${JSON.stringify({ type: "user", uuid: "next", message: { role: "user", content: "thanks" } })}\n`);
    const c = (await h.media(f, { kind: "links", cursor: null, limit: 10 })) as MediaPage;
    expect(c.links![0]).toMatchObject({ norm: "https://live.example/now", count: 2, exchangeId: "live" });
  });

  test("a cursor from an earlier epoch is stale", async () => {
    const f = file(toJsonl(synthRows(300, { seed: 45, urls })));
    const h = createHistory({ reader: fsTranscriptReader });
    const p = (await h.media(f, { kind: "links", cursor: null, limit: 1 })) as MediaPage;
    expect(p.next).not.toBeNull();
    writeFileSync(f, toJsonl(synthRows(100, { seed: 46, urls })));
    expect(await h.media(f, { kind: "links", cursor: p.next, limit: 1 })).toBe("stale");
  });

  test("bounded: at most MAX_MEDIA images and MAX_LINKS links, the newest kept", async () => {
    const rows: string[] = [];
    const total = MAX_LINKS + 300;
    for (let i = 0; i < total; i++) {
      rows.push(JSON.stringify({ type: "user", uuid: `b${i}`, message: { role: "user", content: `https://site${i}.example/ C:\\pics\\p${i}.png` } }));
    }
    const f = file(toJsonl(rows));
    const h = createHistory({ reader: fsTranscriptReader });
    let p: MediaPage;
    for (let i = 0; i < 3000; i++) {
      p = (await h.media(f, { kind: "links", cursor: null, limit: 1 })) as MediaPage;
      if (p.complete) break;
      await Bun.sleep(1);
    }
    expect(p!.complete).toBe(true);
    expect(p!.total).toBe(MAX_LINKS);
    expect(p!.links![0]!.norm).toBe(`https://site${total - 1}.example/`);
    const imgs = (await h.media(f, { kind: "images", cursor: null, limit: 1 })) as MediaPage;
    expect(imgs.total).toBe(MAX_MEDIA);
    expect(imgs.images![0]!.path).toBe(`C:\\pics\\p${total - 1}.png`);
    // Only paths within the list join the allow-list (review M1): the oldest ones, dropped by the cap, do not.
    expect(h.paths(f).has(`C:\\pics\\p${total - 1}.png`)).toBe(true);
    expect(h.paths(f).has("C:\\pics\\p0.png")).toBe(false);
  }, 60_000);
});

describe("link titles", () => {
  test("another link on the same line never becomes the title", () => {
    const t = "compare https://a.example/x e https://b.example/y";
    const start = t.indexOf("https://b");
    expect(titleAround(t, start, t.length)).toBe("compare e");
    const lone = "https://a.example/x: https://b.example/y";
    expect(titleAround(lone, lone.indexOf("https://b"), lone.length)).toBeUndefined();
  });
});
