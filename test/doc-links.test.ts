import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Every relative link and image in the README, the community files and docs/ (not docs/design/, a historical record)
 * points at a file that exists, and every #anchor at a heading of that file. The hero picture is the one exception:
 * it is added separately, and the README reads fine without it.
 */

const root = join(import.meta.dir, "..");
const MAY_BE_MISSING = new Set(["docs/media/hero.png"]);

const docs = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  ...readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

const anchorsOf = (file: string): Set<string> =>
  new Set(
    readFileSync(join(root, file), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#{1,6} /, "").replace(/<[^>]+>/g, ""))),
  );

/** Markdown links and images, and src= of inline HTML, outside fenced code blocks. */
function targets(source: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, "");
    for (const m of plain.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]!);
    for (const m of plain.matchAll(/src="([^"]+)"/g)) out.push(m[1]!);
  }
  return out.filter((t) => !/^(?:https?:|mailto:)/.test(t));
}

test("relative links and images in the docs resolve", () => {
  const broken: string[] = [];
  for (const doc of docs) {
    for (const t of targets(readFileSync(join(root, doc), "utf8"))) {
      const [path, anchor] = t.split("#") as [string, string | undefined];
      const rel = path === "" ? doc : join(dirname(doc), path).split("\\").join("/");
      if (path !== "" && !existsSync(join(root, rel))) {
        if (!MAY_BE_MISSING.has(rel)) broken.push(`${doc}: ${t}`);
        continue;
      }
      if (anchor && rel.endsWith(".md") && !anchorsOf(rel).has(anchor)) broken.push(`${doc}: ${t} (no such heading)`);
    }
  }
  expect(broken).toEqual([]);
});

test("the README shows the logo and the hero picture with alt text", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(readme.split(/\r?\n/)[0]).toContain('src="docs/brand/sidecr-icon.svg"');
  expect(readme).toMatch(/!\[[^\]]{20,}\]\(docs\/media\/hero\.png\)/);
});
