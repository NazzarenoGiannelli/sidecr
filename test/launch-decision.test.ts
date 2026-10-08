import { describe, expect, test } from "bun:test";
import { askToggle, launchDecision } from "../src/launch";
import { createServer } from "../src/server";
import type { HerdrLike } from "../src/herdr";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("launchDecision", () => {
  test("open launches a window", () => {
    expect(launchDecision({ action: "open" })).toBe("launch");
  });
  test("close skips the launch", () => {
    expect(launchDecision({ action: "close" })).toBe("skip");
  });
  test("a close that names windows still skips", () => {
    expect(launchDecision({ action: "close", ids: ["a"] })).toBe("skip");
  });
  test("anything malformed or unknown (an older server) launches", () => {
    for (const bad of [null, undefined, "close", 7, [], {}, { action: "" }, { action: "toggle" }, { action: ["close"] }, { Action: "close" }]) {
      expect(launchDecision(bad)).toBe("launch");
    }
  });
});

describe("askToggle", () => {
  const root = mkdtempSync(join(tmpdir(), "sidecr-launch-"));
  const noHerdr = {} as HerdrLike;
  const made = createServer({
    herdr: noHerdr, token: "tok", attachmentsDir: root, uiDir: root, distDir: root, opener: async () => {},
  });
  const port = Number(made.server.port);
  const info = { pid: process.pid, port, token: "tok" };

  test("a live server answers open, then close", async () => {
    try {
      expect(await askToggle(info, "w1:p1")).toEqual({ action: "open" });
      expect(launchDecision(await askToggle(info, "w1:p1"))).toBe("skip");
    } finally {
      made.server.stop(true);
    }
  });

  test("a server that is not there is no answer, which launches", async () => {
    // A port that was just in use and is now free: nothing listens there, whatever the other tests did.
    const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const freePort = Number(gone.port);
    gone.stop(true);
    const answer = await askToggle({ pid: 1, port: freePort, token: "tok" }, "w1:p1", 300);
    expect(answer).toBeNull();
    expect(launchDecision(answer)).toBe("launch");
  });

  test("a wrong token (401) is no answer", async () => {
    const other = createServer({ herdr: noHerdr, token: "tok", attachmentsDir: root, uiDir: root, distDir: root, opener: async () => {} });
    try {
      const answer = await askToggle({ pid: 1, port: Number(other.server.port), token: "wrong" }, "w1:p1");
      expect(answer).toBeNull();
    } finally {
      other.server.stop(true);
    }
  });

  test("a body that is not JSON is no answer", async () => {
    const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>") });
    try {
      expect(await askToggle({ pid: 1, port: Number(odd.port), token: "t" }, "w1:p1")).toBeNull();
    } finally {
      odd.stop(true);
    }
  });
});
