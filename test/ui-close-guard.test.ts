import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const uiDir = join(import.meta.dir, "..", "ui");

/** The source without comments, so prose that mentions window.close() does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("only ui/shell.ts closes the window directly: every other close goes through closeWindow()", () => {
  // In the native shell window.close() does nothing; a direct call would leave the window open and skip the bye.
  const offenders: string[] = [];
  for (const name of readdirSync(uiDir)) {
    if (!name.endsWith(".ts") || name === "shell.ts") continue;
    const src = code(readFileSync(join(uiDir, name), "utf8"));
    if (/\bwindow\s*\.\s*close\s*\(/.test(src) || /\bself\s*\.\s*close\s*\(/.test(src) || /globalThis\s*\.\s*close\s*\(/.test(src)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});

test("the guard itself sees a direct call and ignores comments", () => {
  expect(/\bwindow\s*\.\s*close\s*\(/.test(code("const a = 1;\nwindow.close();"))).toBe(true);
  expect(/\bwindow\s*\.\s*close\s*\(/.test(code("// window.close() fires beforeunload\n/* window.close() */ const a = 1;"))).toBe(false);
});

test("no GUI spawn hides its window: windowsHide: true stays out of src/os.ts, src/browser.ts and src/shell.ts", () => {
  // SW_HIDE reaches the program that is started (rundll32 passes it on to the application that opens the file), which then has
  // no visible window. Only console children (the herdr CLI in src/herdr.ts, the server in src/state.ts) are hidden.
  const srcDir = join(import.meta.dir, "..", "src");
  const re = /windowsHide\s*:\s*true/;
  const offenders: string[] = [];
  for (const name of ["os.ts", "browser.ts", "shell.ts"]) {
    if (re.test(code(readFileSync(join(srcDir, name), "utf8")))) offenders.push(name);
  }
  expect(offenders).toEqual([]);
  // the guard sees the forms it is meant to see, and ignores prose
  expect(re.test(code("spawn(cmd, { windowsHide: true });"))).toBe(true);
  expect(re.test(code("spawn(cmd, {windowsHide:true});"))).toBe(true);
  expect(re.test(code("// no windowsHide: true here\n/* windowsHide: true */ spawn(cmd);"))).toBe(false);
});
