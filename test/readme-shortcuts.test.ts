import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHORTCUTS } from "../ui/keys";

/*
 * The README's shortcut table is the registry in ui/keys.ts (the one the in-app cheat sheet is drawn from), row for
 * row and in the same order: group, keys and label. A row may add a note in parentheses after the label; a shortcut
 * of the native shell only must say so there, and no other may.
 */

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const HEADER = "| Group | Keys | What it does |";

interface Row {
  group: string;
  keys: string[];
  text: string;
}

function tableRows(): Row[] {
  const lines = readme.split(/\r?\n/);
  const start = lines.indexOf(HEADER);
  expect(start).toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    expect(cells).toHaveLength(3);
    rows.push({ group: cells[0]!, keys: [...cells[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!), text: cells[2]! });
  }
  return rows;
}

test("every shortcut of the registry is in the README table, in order, with its group, keys and label", () => {
  const rows = tableRows();
  expect(rows.map((r) => [r.group, r.keys])).toEqual(SHORTCUTS.map((s) => [s.group, [...s.keys]]));
  rows.forEach((r, i) => {
    const s = SHORTCUTS[i]!;
    expect(r.text.startsWith(s.label), `${s.id}: "${r.text}"`).toBe(true);
    const rest = r.text.slice(s.label.length);
    expect(rest === "" || /^ \(.+\)$/.test(rest), `${s.id}: only a note in parentheses may follow the label`).toBe(true);
    expect(rest.includes("native shell only"), `${s.id}: native shell only`).toBe(Boolean(s.shellOnly));
  });
});

test("the guard notices a drifted row", () => {
  const drifted = { group: "Window", keys: ["Alt+S"], text: "Open Sidecr" };
  const s = SHORTCUTS.find((x) => x.id === "herdr-toggle")!;
  expect(drifted.text.startsWith(s.label)).toBe(false);
});
