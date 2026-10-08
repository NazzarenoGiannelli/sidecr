import { expect, test } from "bun:test";
import { join } from "node:path";
import { isAllowedFile, isOpenablePath, isImagePath } from "../src/files";

const dir = join("/state", "attachments");

test("image extensions", () => {
  expect(isImagePath("a.PNG")).toBe(true);
  expect(isImagePath("a.txt")).toBe(false);
});

test("allows listed paths and the files Sidecr saved in the attachments dir", () => {
  expect(isAllowedFile("/tmp/a.png", ["/tmp/a.png"], dir)).toBe(true);
  expect(isAllowedFile(join(dir, "20261008-101500-x.png"), [], dir)).toBe(true);
  expect(isAllowedFile(join(dir, "2-20261008-101500-x.png"), [], dir)).toBe(true);
});

test("in the attachments dir only Sidecr's own files, directly inside it: SIDECR_ATTACHMENTS_DIR may point at a shared folder", () => {
  expect(isAllowedFile(join(dir, "x.png"), [], dir)).toBe(false);
  expect(isAllowedFile(join(dir, "sub", "20261008-101500-x.png"), [], dir)).toBe(false);
});

test("denies unlisted paths and traversal out of the attachments dir", () => {
  expect(isAllowedFile("/etc/passwd", ["/tmp/a.png"], dir)).toBe(false);
  expect(isAllowedFile(join(dir, "..", "secret.txt"), [], dir)).toBe(false);
});

test("only allow-listed document and image types are opened", () => {
  for (const f of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.svg", "a.pdf", "n.md", "n.TXT", "d.json", "d.csv", "d.log", "a.docx", "a.xlsx", "a.pptx", "p.html", "P.HTM", "p.htm"]) {
    expect(isOpenablePath(f)).toBe(true);
  }
});

test("scripts, executables and extension-less files are never opened", () => {
  for (const f of ["a.exe", "a.BAT", "a.ps1", "a.sh", "a.py", "a.rb", "a.msi", "a.lnk", "a.js", "a.jar", "a.url", "Makefile", "a.md.exe", "notes."]) {
    expect(isOpenablePath(f)).toBe(false);
  }
});

test("everything that runs or installs stays refused, in any case, and a script hidden behind .html is not an html file", () => {
  const never = ["exe", "bat", "cmd", "com", "ps1", "psm1", "sh", "msi", "js", "mjs", "vbs", "vbe", "wsf", "hta", "jar", "lnk", "url", "reg", "scr", "dll", "appimage", "desktop"];
  for (const ext of never) {
    expect(isOpenablePath(`a.${ext}`), ext).toBe(false);
    expect(isOpenablePath(`A.${ext.toUpperCase()}`), ext).toBe(false);
    expect(isOpenablePath(`page.html.${ext}`), ext).toBe(false);
  }
  // look-alikes of html are not on the list: only the two extensions the user asked for
  for (const f of ["a.xhtml", "a.shtml", "a.mhtml", "a.mht", "a.html.", "a.html "]) expect(isOpenablePath(f), f).toBe(false);
});
