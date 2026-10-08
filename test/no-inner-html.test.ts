import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The window renders model output and file contents, so it never parses HTML from a string: every node is built with
 * createElement and textContent. This fails, with file:line, if an HTML-parsing sink shows up in ui/ (code only;
 * comments are skipped).
 */

const SINK = /\.(?:innerHTML|outerHTML)\s*[+]?=|\.insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|\.createContextualFragment\s*\(|\.setHTMLUnsafe\s*\(|\bparseFromString\s*\(/;

const uiDir = join(import.meta.dir, "..", "ui");

export function sinksIn(source: string): number[] {
  const lines: number[] = [];
  let inBlock = false;
  source.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      inBlock = true;
    }
    const comment = line.indexOf("//");
    if (comment >= 0) line = line.slice(0, comment);
    if (SINK.test(line)) lines.push(i + 1);
  });
  return lines;
}

test("no HTML-parsing sink in the window's code", () => {
  const hits: string[] = [];
  for (const name of readdirSync(uiDir)) {
    if (!/\.(ts|js)$/.test(name)) continue;
    for (const line of sinksIn(readFileSync(join(uiDir, name), "utf8"))) hits.push(`ui/${name}:${line}`);
  }
  expect(hits).toEqual([]);
});

test("the guard sees the sinks it is for, and not the words in comments", () => {
  expect(sinksIn("el.innerHTML = x;")).toEqual([1]);
  expect(sinksIn("el.outerHTML += x;")).toEqual([1]);
  expect(sinksIn("a\nel.insertAdjacentHTML('beforeend', x);")).toEqual([2]);
  expect(sinksIn("document.write(x)")).toEqual([1]);
  expect(sinksIn("new DOMParser().parseFromString(x, 'text/html')")).toEqual([1]);
  expect(sinksIn("// never innerHTML = here\n/* el.innerHTML = x */ ok();\n/*\n el.innerHTML = x\n*/")).toEqual([]);
  expect(sinksIn("el.textContent = x;")).toEqual([]);
});
