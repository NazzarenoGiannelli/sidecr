import { describe, expect, test } from "bun:test";
import {
  CLOSE_SIDECR_QUERY,
  isCloseSignal,
  isLightboxSrc,
  LIGHTBOX_CLOSED_EVENT,
  lightboxArgs,
  lightboxPageKey,
  lightboxSrcOf,
  MAX_IMAGES,
  MAX_SRC_LEN,
  parseLightboxQuery,
  stepIndex,
} from "../ui/lightbox-window";

const origin = "http://localhost:47631";

describe("isLightboxSrc (what the page may hand to open_lightbox)", () => {
  test("the two image endpoints with a query", () => {
    expect(isLightboxSrc("/api/file?pane=w1%3Ap1&path=C%3A%5Cx.png")).toBe(true);
    expect(isLightboxSrc("/api/image?pane=p&ex=u3&block=u1")).toBe(true);
  });
  test("nothing else", () => {
    for (const bad of [
      "", null, 42, "/api/file", "/api/file?", "/api/file?x#y", "/api/send?x=1", "/lightbox.html?src=1",
      "http://localhost:47631/api/file?x=1", "//evil.example/api/file?x=1", "api/file?x=1", "\\\\srv\\x.png",
      "/api/file?x=1\n", "data:image/png;base64,AA", "javascript:alert(1)", `/api/file?path=${"a".repeat(MAX_SRC_LEN)}`,
    ]) {
      expect(isLightboxSrc(bad), String(bad)).toBe(false);
    }
  });
  test("the constants match the Rust side", async () => {
    const rust = await Bun.file(new URL("../shell/src-tauri/src/lightbox.rs", import.meta.url)).text();
    expect(rust).toContain(`pub const MAX_IMAGES: usize = ${MAX_IMAGES};`);
    expect(rust).toContain(`pub const MAX_SRC_LEN: usize = ${MAX_SRC_LEN};`);
    expect(rust).toContain('const IMAGE_PATHS: [&str; 2] = ["/api/file", "/api/image"];');
    const main = await Bun.file(new URL("../shell/src-tauri/src/main.rs", import.meta.url)).text();
    expect(main).toContain(`const LIGHTBOX_CLOSED_EVENT: &str = "${LIGHTBOX_CLOSED_EVENT}";`);
  });
});

describe("lightboxSrcOf (a thumbnail to its lightbox URL)", () => {
  test("an /api/file thumbnail keeps its path and query", () => {
    expect(lightboxSrcOf({ src: `${origin}/api/file?pane=p&path=a.png` }, origin, "p")).toBe("/api/file?pane=p&path=a.png");
  });
  test("a data: thumbnail (pasted into the terminal) becomes /api/image by exchange and block", () => {
    expect(lightboxSrcOf({ src: "data:image/png;base64,AAAA", ex: "u-1 2", block: "u1" }, origin, "w1:p1")).toBe("/api/image?pane=w1%3Ap1&ex=u-1%202&block=u1");
  });
  test("a data: thumbnail without its exchange, another origin, or another path gives null", () => {
    expect(lightboxSrcOf({ src: "data:image/png;base64,AAAA" }, origin, "p")).toBeNull();
    expect(lightboxSrcOf({ src: "data:image/png;base64,AAAA", ex: "u1", block: "x" }, origin, "p")).toBeNull();
    expect(lightboxSrcOf({ src: "http://localhost:9999/api/file?path=a" }, origin, "p")).toBeNull();
    expect(lightboxSrcOf({ src: `${origin}/favicon.svg` }, origin, "p")).toBeNull();
    expect(lightboxSrcOf({ src: "blob:http://localhost:47631/abc" }, origin, "p")).toBeNull();
  });
});

describe("lightboxArgs", () => {
  test("the valid images in page order and the clicked one's index among them", () => {
    expect(lightboxArgs(["/api/file?a=1", null, "/api/file?b=2", "/api/image?c=3"], 2)).toEqual({ srcs: ["/api/file?a=1", "/api/file?b=2", "/api/image?c=3"], index: 1 });
  });
  test("a clicked image that is not valid gives null", () => {
    expect(lightboxArgs(["/api/file?a=1", null], 1)).toBeNull();
    expect(lightboxArgs([], 0)).toBeNull();
  });
  test("more than the maximum: a window around the clicked one", () => {
    const all = Array.from({ length: 100 }, (_, i) => `/api/file?i=${i}`);
    const r = lightboxArgs(all, 90)!;
    expect(r.srcs).toHaveLength(MAX_IMAGES);
    expect(r.srcs[r.index]).toBe("/api/file?i=90");
    const first = lightboxArgs(all, 0)!;
    expect(first.index).toBe(0);
    expect(first.srcs[0]).toBe("/api/file?i=0");
  });
});

describe("the lightbox page", () => {
  test("reads only valid URLs from its query and clamps the index", () => {
    const q = new URLSearchParams();
    q.append("i", "1");
    q.append("src", "/api/file?a=1");
    q.append("src", "https://evil.example/x?y");
    q.append("src", "/api/image?b=2");
    expect(parseLightboxQuery(`?${q}`)).toEqual({ srcs: ["/api/file?a=1", "/api/image?b=2"], index: 1 });
    expect(parseLightboxQuery("?i=9&src=%2Fapi%2Ffile%3Fa%3D1").index).toBe(0);
    expect(parseLightboxQuery("?i=-1&src=%2Fapi%2Ffile%3Fa%3D1").index).toBe(0);
    expect(parseLightboxQuery("")).toEqual({ srcs: [], index: 0 });
  });
  test("steps wrap around", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
  test("keys: Esc and F close, Left/Right step, anything with a modifier passes", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean; code: string }> = {}) => ({ key, code: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(lightboxPageKey(k("Escape"))).toBe("close");
    expect(lightboxPageKey(k("Escape", { repeat: true }))).toBe("pass"); // a held Esc must not reach main's layers
    expect(lightboxPageKey(k("f"))).toBe("close");
    expect(lightboxPageKey(k("F"))).toBe("close");
    expect(lightboxPageKey(k("f", { repeat: true }))).toBe("pass");
    expect(lightboxPageKey(k("ArrowLeft"))).toBe("prev");
    expect(lightboxPageKey(k("ArrowRight"))).toBe("next");
    expect(lightboxPageKey(k("ArrowRight", { altKey: true }))).toBe("pass");
    expect(lightboxPageKey(k("x"))).toBe("pass");
  });
  test("the close chord (Alt+S, Ctrl+Shift+J) in the lightbox window closes Sidecr, as everywhere else", () => {
    const k = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(lightboxPageKey(k("s", "KeyS", { altKey: true }))).toBe("quit");
    expect(lightboxPageKey(k("J", "KeyJ", { ctrlKey: true, shiftKey: true }))).toBe("quit");
    expect(lightboxPageKey(k("s", "KeyS", { altKey: true, ctrlKey: true }))).toBe("pass"); // AltGr
    expect(lightboxPageKey(k("s", "KeyS", { altKey: true, repeat: true }))).toBe("pass");
  });
  test("the close signal query matches the Rust side", async () => {
    const rust = await Bun.file(new URL("../shell/src-tauri/src/lightbox.rs", import.meta.url)).text();
    expect(rust).toContain(`pub const CLOSE_SIDECR_QUERY: (&str, &str) = ("${CLOSE_SIDECR_QUERY[0]}", "${CLOSE_SIDECR_QUERY[1]}");`);
    expect(isCloseSignal(`?${CLOSE_SIDECR_QUERY[0]}=${CLOSE_SIDECR_QUERY[1]}`)).toBe(true);
    expect(isCloseSignal("?i=0&src=%2Fapi%2Ffile%3Fa")).toBe(false);
  });
});
