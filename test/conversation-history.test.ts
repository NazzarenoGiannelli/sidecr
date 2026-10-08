import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrLike, PaneInfo } from "../src/herdr";
import { blockSize, createServer, isExchangeId, MAX_BLOCK } from "../src/server";
import { encodeCwd } from "../src/transcript/locate";
import { parseTranscript, type Exchange } from "../src/transcript/parse";
import { synthRows, toJsonl } from "./synthetic";

const TOKEN = "tok-hist";
const root = mkdtempSync(join(tmpdir(), "sidecr-convhist-"));
const projects = join(root, "projects");
const CWD = join(root, "work");
const dir = join(projects, encodeCwd(CWD));
mkdirSync(dir, { recursive: true });
const oldImage = join(root, "old-shot.png");
writeFileSync(oldImage, "OLDPNG");
const PNG = Buffer.from("fake png bytes").toString("base64");

// A long session: an image path in the third exchange and an inline image in the fourth, 400 synthetic rows after.
const head = [
  JSON.stringify({ type: "user", uuid: "h1", timestamp: "2026-10-01T08:00:00.000Z", message: { role: "user", content: "first" } }),
  JSON.stringify({ type: "user", uuid: "h2", timestamp: "2026-10-01T08:01:00.000Z", message: { role: "user", content: "second" } }),
  JSON.stringify({ type: "user", uuid: "h3", timestamp: "2026-10-01T08:02:00.000Z", message: { role: "user", content: `look at ${oldImage}` } }),
  JSON.stringify({ type: "user", uuid: "h4", timestamp: "2026-10-01T08:03:00.000Z", message: { role: "user", content: [{ type: "text", text: "pasted" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] } }),
];
const rows = [...head, ...synthRows(2000, { seed: 31 })];
writeFileSync(join(dir, "long.jsonl"), toJsonl(rows));
const everything = parseTranscript(rows, Number.MAX_SAFE_INTEGER);

let status = "idle";
const herdr: HerdrLike = {
  getPane: async (id): Promise<PaneInfo> => ({ paneId: id, agent: "claude", agentStatus: status, sessionId: "long", cwd: CWD, title: "t", workspaceId: "w1" }),
  listAgentPanes: async () => [],
  listWorkspaces: async () => [{ id: "w1", label: "personal" }],
  readScreen: async () => "",
  sendText: async () => {},
  sendKeys: async () => {},
};
const made = createServer({ herdr, token: TOKEN, attachmentsDir: join(root, "att"), projectsRoot: projects, uiDir: root, distDir: root, opener: async () => {} });
const base = `http://127.0.0.1:${Number(made.server.port)}`;
const H = { headers: { cookie: `sidecr=${TOKEN}` } };
afterAll(() => made.server.stop(true));

interface Body {
  exchanges: Exchange[];
  hasMore: boolean;
  oldestId: string | null;
  epoch: number;
  activity?: { startedAt?: string };
  error?: string;
}
const conv = async (q = "") => {
  const res = await fetch(`${base}/api/conversation?pane=w1:p1${q}`, H);
  return { status: res.status, body: (await res.json()) as Body };
};

describe("query helpers", () => {
  test("n is clamped to 1..50; not a number is invalid; absent is the fallback", () => {
    expect(blockSize(null, 7)).toBe(7);
    expect(blockSize("", 7)).toBe(7);
    expect(blockSize("0", 7)).toBe(1);
    expect(blockSize("-4", 7)).toBe(1);
    expect(blockSize("999", 7)).toBe(MAX_BLOCK);
    expect(blockSize("12", 7)).toBe(12);
    for (const bad of ["abc", "1.5", "1e3", "12x", "9999999"]) expect(blockSize(bad, 7)).toBeNull();
  });
  test("exchange ids: 1..200 characters, no control characters", () => {
    expect(isExchangeId("u-1")).toBe(true);
    expect(isExchangeId("@12345")).toBe(true);
    expect(isExchangeId("")).toBe(false);
    expect(isExchangeId(null)).toBe(false);
    expect(isExchangeId("x".repeat(201))).toBe(false);
    expect(isExchangeId("a\nb")).toBe(false);
  });
});

describe("GET /api/conversation with history", () => {
  test("the tail carries hasMore, oldestId, the epoch and a stable id on every exchange", async () => {
    const a = await conv();
    expect(a.status).toBe(200);
    expect(a.body.exchanges).toEqual(parseTranscript(rows, 5));
    expect(a.body.hasMore).toBe(true);
    expect(a.body.oldestId).toBe(a.body.exchanges[0]!.id);
    expect(typeof a.body.epoch).toBe("number");
    const b = await conv();
    expect(b.body.exchanges.map((e) => e.id)).toEqual(a.body.exchanges.map((e) => e.id));
    expect(b.body.epoch).toBe(a.body.epoch);
  });

  test("older blocks page back to the beginning, and together equal the full parse", async () => {
    const tail = (await conv()).body;
    let all = tail.exchanges;
    let page = tail;
    let blocks = 0;
    while (page.hasMore) {
      const r = await conv(`&before=${encodeURIComponent(page.oldestId!)}&n=50`);
      expect(r.status).toBe(200);
      expect(r.body.activity).toBeUndefined();
      expect(r.body.epoch).toBe(tail.epoch);
      all = r.body.exchanges.concat(all);
      page = r.body;
      blocks++;
      if (r.body.exchanges.length === 0) break;
    }
    expect(blocks).toBeGreaterThan(3);
    expect(all).toEqual(everything);
  });

  test("n defaults to loadBlock (10) for a block and is clamped", async () => {
    const tail = (await conv()).body;
    const q = `&before=${encodeURIComponent(tail.oldestId!)}`;
    const real = (b: Body) => b.exchanges.filter((e) => !e.queued).length;
    expect(real((await conv(q)).body)).toBe(10);
    expect(real((await conv(`${q}&n=0`)).body)).toBe(1);
    expect(real((await conv(`${q}&n=1000`)).body)).toBe(50);
    expect(real((await conv("&n=2")).body)).toBe(2); // the tail takes n too
  });

  test("an invalid or unknown before is a clear 4xx with an error, never a throw", async () => {
    const bad = await conv(`&before=${"x".repeat(201)}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad-request");
    expect((await conv("&before=")).status).toBe(400);
    expect((await conv("&before=a%0Ab")).status).toBe(400);
    expect((await conv("&n=lots")).status).toBe(400);
    const unknown = await conv("&before=no-such-exchange");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("unknown-exchange");
  });

  test("the gates: cookie and Host", async () => {
    expect((await fetch(`${base}/api/conversation?pane=w1:p1&before=h2`)).status).toBe(401);
    expect((await fetch(`${base}/api/conversation?pane=w1:p1&before=h2`, { headers: { ...H.headers, host: "evil.example" } })).status).toBe(403);
  });

  test("activity comes from the tail only (a block never computes it)", async () => {
    status = "working";
    try {
      const tail = await conv();
      expect(tail.body.activity).toBeDefined();
      const lastTurn = parseTranscript(rows, 1);
      expect(tail.body.activity!.startedAt).toBe(lastTurn[0]!.startedAt);
      const block = await conv(`&before=${encodeURIComponent(tail.body.oldestId!)}`);
      expect(block.body.activity).toBeUndefined();
    } finally {
      status = "idle";
    }
  });
});

describe("allow-lists cover the blocks the window loaded", () => {
  test("an image mentioned in an old exchange: refused before its block is loaded, served after", async () => {
    const fresh = createServer({ herdr, token: TOKEN, attachmentsDir: join(root, "att"), projectsRoot: projects, uiDir: root, distDir: root, opener: async () => {} });
    const b = `http://127.0.0.1:${Number(fresh.server.port)}`;
    try {
      const file = () => fetch(`${b}/api/file?pane=w1:p1&path=${encodeURIComponent(oldImage)}`, H);
      expect((await file()).status).toBe(403);
      // Page back until exchange h3 is in.
      let page = (await (await fetch(`${b}/api/conversation?pane=w1:p1`, H)).json()) as Body;
      while (page.hasMore && !page.exchanges.some((e) => e.id === "h3")) {
        page = (await (await fetch(`${b}/api/conversation?pane=w1:p1&before=${encodeURIComponent(page.oldestId!)}&n=50`, H)).json()) as Body;
      }
      expect(page.exchanges.some((e) => e.id === "h3")).toBe(true);
      // At once: the memo holds the session's live set, which the block just joined.
      const res = await file();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OLDPNG");
      // A path that no exchange mentions stays refused.
      expect((await fetch(`${b}/api/file?pane=w1:p1&path=${encodeURIComponent(join(root, "other.png"))}`, H)).status).toBe(403);
    } finally {
      fresh.server.stop(true);
    }
  });

  test("/api/image serves an inline image of any exchange of the session, with the same headers and gates", async () => {
    const get = (q: string, headers: Record<string, string> = H.headers) => fetch(`${base}/api/image?${q}`, { headers });
    const ok = await get("pane=w1:p1&ex=h4&block=u1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toBe("sandbox");
    expect(await ok.text()).toBe("fake png bytes");
    expect((await get("pane=w1:p1&ex=h4&block=u0")).status).toBe(404); // a text block
    expect((await get("pane=w1:p1&ex=nope&block=u1")).status).toBe(404);
    expect((await get("pane=w1:p1&ex=h4&block=u1", {})).status).toBe(401);
  });
});
