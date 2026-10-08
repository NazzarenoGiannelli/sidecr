import { describe, expect, test } from "bun:test";
import { tokenize } from "../src/tokenize";
import { cheatSheet } from "../ui/keys";
import { activatesLink, FILE_REVEALED_NOTICE, fileFailureNotice, openedNotice, folderFailureNotice, linkSpec, OPEN_FOLDER_TITLE, REVEAL_NOTICE, revealInstead, wantsReveal } from "../ui/path-link";

/** What the renderer would make of a text: [text, kind, folder, focusable] for each link. */
const links = (s: string) =>
  tokenize(s).filter((t) => t.type !== "text").map((t) => [t.value, linkSpec(t).kind, linkSpec(t).folder, linkSpec(t).focusable] as const);

describe("linkSpec: token to link", () => {
  test("a folder candidate is a dir link with the folder look, a tooltip and keyboard access", () => {
    expect(linkSpec({ type: "path", dir: true })).toEqual({ kind: "dir", title: "Open folder", folder: true, focusable: true });
    expect(OPEN_FOLDER_TITLE).toBe("Open folder");
  });
  test("files and URLs keep the kind they always sent", () => {
    expect(linkSpec({ type: "path" })).toEqual({ kind: "path", folder: false, focusable: false });
    expect(linkSpec({ type: "url" })).toEqual({ kind: "url", folder: false, focusable: false });
  });
  test("from text: folders, files and a URL side by side", () => {
    expect(links("saved to C:\\out\\run1\\ and /home/x/run2, plus ~/a.png and https://x.dev/y/")).toEqual([
      ["C:\\out\\run1\\", "dir", true, true],
      ["/home/x/run2", "dir", true, true],
      ["~/a.png", "path", false, false],
      ["https://x.dev/y/", "url", false, false],
    ]);
  });
  test("inside backticks", () => {
    expect(links("`C:/Users/x/folder`")).toEqual([["C:/Users/x/folder", "dir", true, true]]);
  });
  test("slash words are not links at all", () => {
    expect(links("the /api and /tmp")).toEqual([]);
  });
});

describe("folderFailureNotice", () => {
  test("a folder that is gone, and a path that is not a folder", () => {
    expect(folderFailureNotice({ code: "not-found", status: 404 })).toBe("That folder no longer exists");
    expect(folderFailureNotice({ code: "not-a-directory", status: 415 })).toBe("That path is not a folder");
  });
  test("the other refusals have their own text", () => {
    expect(folderFailureNotice({ code: "forbidden" })).toMatch(/not one this conversation mentions/);
    expect(folderFailureNotice({ code: "bad-path" })).toMatch(/cannot be opened/);
  });
  test("anything else shows the server's message, or a plain fallback", () => {
    expect(folderFailureNotice({ message: "boom" })).toBe("boom");
    expect(folderFailureNotice({})).toBe("The folder did not open");
  });
});

describe("activatesLink", () => {
  test("Enter and Space open a focused link", () => {
    expect(activatesLink({ key: "Enter" })).toBe(true);
    expect(activatesLink({ key: " " })).toBe(true);
  });
  test("other keys, and chords with Ctrl, Alt or Meta, do not", () => {
    expect(activatesLink({ key: "a" })).toBe(false);
    expect(activatesLink({ key: "Tab" })).toBe(false);
    expect(activatesLink({ key: "Enter", ctrlKey: true })).toBe(false);
    expect(activatesLink({ key: "Enter", altKey: true })).toBe(false);
    expect(activatesLink({ key: " ", metaKey: true })).toBe(false);
  });
});

describe("show in folder", () => {
  test("a file the server will not open is shown in its folder instead, and the notice says so", () => {
    expect(revealInstead("path", { code: "type-not-openable", status: 403 })).toBe(true);
    expect(REVEAL_NOTICE).toMatch(/shown in its folder/);
  });
  test("only a file link, and only for that refusal", () => {
    expect(revealInstead("path", { code: "forbidden" })).toBe(false);
    expect(revealInstead("path", { code: "not-found" })).toBe(false);
    expect(revealInstead("dir", { code: "type-not-openable" })).toBe(false);
    expect(revealInstead("url", { code: "type-not-openable" })).toBe(false);
    expect(revealInstead(undefined, {})).toBe(false);
  });
  test("Shift+click on a file link is the secondary way, on any file type", () => {
    expect(wantsReveal("path", { shiftKey: true })).toBe(true);
    expect(wantsReveal("path", { shiftKey: false })).toBe(false);
    expect(wantsReveal("path", {})).toBe(false);
    expect(wantsReveal("dir", { shiftKey: true })).toBe(false);
    expect(wantsReveal("url", { shiftKey: true })).toBe(false);
  });
  test("a file that is gone or not mentioned has its own notice; anything else shows the server's message", () => {
    expect(fileFailureNotice({ code: "not-found" })).toBe("That file no longer exists");
    expect(fileFailureNotice({ code: "forbidden" })).toMatch(/not one this conversation mentions/);
    expect(fileFailureNotice({ message: "boom" })).toBe("boom");
    expect(fileFailureNotice({})).toBe("The file did not open");
  });
});

describe("the cheat sheet lists the mouse behaviours of links", () => {
  test("a click on a folder link, Shift+click on a file link", () => {
    const rows = cheatSheet({ inShell: false }).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === "open-folder")?.keys).toEqual(["Click"]);
    expect(rows.find((r) => r.id === "reveal-file")?.keys).toEqual(["Shift+Click"]);
  });
});

describe("a folder link that was a regular file", () => {
  test("the server's revealed answer gets a notice; the ordinary answers get none", () => {
    expect(openedNotice({ ok: true, revealed: true })).toBe(FILE_REVEALED_NOTICE);
    expect(FILE_REVEALED_NOTICE).toMatch(/shown in its folder/);
    expect(openedNotice({ ok: true })).toBeNull();
    expect(openedNotice({ ok: true, revealed: "yes" })).toBeNull();
    expect(openedNotice(null)).toBeNull();
    expect(openedNotice(undefined)).toBeNull();
  });
});
