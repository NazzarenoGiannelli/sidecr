import { describe, expect, test } from "bun:test";

// What `herdr plugin install` and the marketplace index read, and what a release tag claims: the manifest, package.json,
// the native shell's Cargo.toml and the LICENSE must tell the same story.

const text = (rel: string) => Bun.file(new URL(`../${rel}`, import.meta.url)).text();
const pkg = async () => JSON.parse(await text("package.json"));
const manifest = async () => Bun.TOML.parse(await text("herdr-plugin.toml")) as Record<string, any>;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("herdr-plugin.toml", () => {
  test("has the fields the marketplace requires: id, name, version, min_herdr_version", async () => {
    const m = await manifest();
    for (const key of ["id", "name", "version", "min_herdr_version"]) {
      expect(typeof m[key]).toBe("string");
      expect((m[key] as string).length).toBeGreaterThan(0);
    }
    expect(m.id).toBe("nazz.sidecr");
    expect(m.name).toBe("Sidecr");
    expect(m.version).toMatch(SEMVER);
    expect(m.min_herdr_version).toMatch(SEMVER);
  });

  test("declares Linux and Windows only (macOS is not supported yet)", async () => {
    expect((await manifest()).platforms).toEqual(["linux", "windows"]);
  });

  test("builds with bun install and build:ui, and the open action runs src/open.ts", async () => {
    const m = await manifest();
    expect(m.build.map((b: { command: string[] }) => b.command)).toEqual([
      ["bun", "install"],
      ["bun", "run", "build:ui"],
    ]);
    expect(m.actions).toEqual([{ id: "open", title: "Open Sidecr", contexts: ["workspace"], command: ["bun", "src/open.ts"] }]);
    const p = await pkg();
    expect(p.scripts["build:ui"]).toContain("ui/app.ts");
    expect(await Bun.file(new URL("../src/open.ts", import.meta.url)).exists()).toBe(true);
  });
});

describe("package.json", () => {
  test("metadata for the GitHub repository: MIT, author without an email, never published to npm", async () => {
    const p = await pkg();
    // herdr installs from GitHub and the marketplace reads herdr-plugin.toml; private keeps an accidental npm publish out.
    expect(p.private).toBe(true);
    expect(p.license).toBe("MIT");
    expect(typeof p.author).toBe("string");
    expect(p.author).not.toContain("@");
    expect(p.repository).toEqual({ type: "git", url: "git+https://github.com/NazzarenoGiannelli/sidecr.git" });
    expect(p.homepage).toBe("https://github.com/NazzarenoGiannelli/sidecr#readme");
    expect(p.bugs).toEqual({ url: "https://github.com/NazzarenoGiannelli/sidecr/issues" });
    for (const k of ["herdr", "herdr-plugin", "claude-code", "companion", "terminal", "tauri"]) expect(p.keywords).toContain(k);
  });

  test("development dependencies are pinned, so the typecheck does not change under a contributor without a commit", async () => {
    const p = await pkg();
    expect(Object.values(p.devDependencies as Record<string, string>).filter((v) => v === "latest" || v === "*")).toEqual([]);
    expect(p.devDependencies["@types/bun"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("one name, one version", () => {
  test("package.json, herdr-plugin.toml and the shell's Cargo.toml agree on the version", async () => {
    const p = await pkg();
    const m = await manifest();
    const cargo = Bun.TOML.parse(await text("shell/src-tauri/Cargo.toml")) as { package: { version: string } };
    expect(p.version).toMatch(SEMVER);
    expect(m.version).toBe(p.version);
    expect(cargo.package.version).toBe(p.version);
  });

  test("the plugin id and display name are the package name", async () => {
    const p = await pkg();
    const m = await manifest();
    expect(p.name).toBe("sidecr");
    expect(m.name.toLowerCase()).toBe(p.name);
    expect(m.id.endsWith(`.${p.name}`)).toBe(true);
  });

  test("the CHANGELOG has a section for the current version (the release notes come from it)", async () => {
    const p = await pkg();
    expect((await text("CHANGELOG.md")).split(/\r?\n/).some((l) => l.startsWith(`## [${p.version}] - `))).toBe(true);
  });
});

test("LICENSE is MIT with the same holder as package.json's author", async () => {
  const license = (await text("LICENSE")).replace(/\r\n/g, "\n");
  const p = await pkg();
  expect(license.startsWith("MIT License\n")).toBe(true);
  expect(license).toContain(`Copyright (c) 2026 ${p.author}\n`);
});
