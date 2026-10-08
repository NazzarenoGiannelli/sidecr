import { expect, test } from "bun:test";
import { escapeLayer } from "../ui/escape";

test("lightbox wins over everything, it paints on top", () => {
  expect(escapeLayer({ lightboxOpen: true, overlayOpen: true, trayCount: 2 })).toBe("lightbox");
  expect(escapeLayer({ lightboxOpen: true, overlayOpen: false, trayCount: 0 })).toBe("lightbox");
});

test("switcher is next when the lightbox is closed", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: true, trayCount: 3 })).toBe("overlay");
});

test("with no overlay open, Esc clears a non-empty tray", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 1 })).toBe("tray");
});

test("nothing open and an empty tray means nothing to do", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 0 })).toBe("none");
});

test("the order: lightbox, switcher, settings, cheat sheet, tray, notice", () => {
  const all = { lightboxOpen: true, overlayOpen: true, settingsOpen: true, cheatSheetOpen: true, trayCount: 1, noticeShown: true, composerEmpty: true };
  expect(escapeLayer(all)).toBe("lightbox");
  expect(escapeLayer({ ...all, lightboxOpen: false })).toBe("overlay");
  expect(escapeLayer({ ...all, lightboxOpen: false, overlayOpen: false })).toBe("settings");
  expect(escapeLayer({ ...all, lightboxOpen: false, overlayOpen: false, settingsOpen: false })).toBe("cheatsheet");
  expect(escapeLayer({ ...all, lightboxOpen: false, overlayOpen: false, settingsOpen: false, cheatSheetOpen: false })).toBe("tray");
  expect(escapeLayer({ ...all, lightboxOpen: false, overlayOpen: false, settingsOpen: false, cheatSheetOpen: false, trayCount: 0 })).toBe("notice");
});

test("nothing open and an empty composer: Esc closes Sidecr", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 0, composerEmpty: true })).toBe("close");
});

test("a draft in the composer, a tray or an open layer keeps the window open", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 0, composerEmpty: false })).toBe("none");
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 1, composerEmpty: true })).toBe("tray");
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 0, noticeShown: true, composerEmpty: true })).toBe("notice");
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, cheatSheetOpen: true, trayCount: 0, composerEmpty: true })).toBe("cheatsheet");
});

test("an unknown composer state never closes", () => {
  expect(escapeLayer({ lightboxOpen: false, overlayOpen: false, trayCount: 0 })).toBe("none");
});

test("an auto-repeated Esc does nothing: holding Esc closes only the top layer, never Sidecr after it", () => {
  const idle = { lightboxOpen: false, overlayOpen: false, trayCount: 0, composerEmpty: true };
  expect(escapeLayer({ ...idle, repeat: true })).toBe("none");
  expect(escapeLayer({ ...idle, overlayOpen: true, repeat: true })).toBe("none");
  expect(escapeLayer({ ...idle, lightboxOpen: true, repeat: true })).toBe("none");
  expect(escapeLayer({ ...idle, repeat: false })).toBe("close");
});

test("the Media & links panel closes after the cheat sheet and before the tray; an image opened from it goes first", () => {
  const base = { lightboxOpen: false, overlayOpen: false, trayCount: 1, composerEmpty: true, mediaOpen: true };
  expect(escapeLayer(base)).toBe("media");
  expect(escapeLayer({ ...base, lightboxOpen: true })).toBe("lightbox");
  expect(escapeLayer({ ...base, cheatSheetOpen: true })).toBe("cheatsheet");
  expect(escapeLayer({ ...base, mediaOpen: false })).toBe("tray");
});
