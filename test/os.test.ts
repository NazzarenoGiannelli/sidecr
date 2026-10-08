import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryCommand, guiSpawnOptions, openDirectory, openExternal, revealCommand, revealFile, type SpawnFn } from "../src/os";

function recorder() {
  const calls: { cmd: string[]; opts: Parameters<SpawnFn>[1] }[] = [];
  let unrefs = 0;
  const spawn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, opts });
    return { unref: () => void unrefs++ };
  };
  return { calls, spawn, unrefs: () => unrefs };
}

describe("openDirectory: the command that shows a folder", () => {
  test("Windows: explorer.exe, the folder always in double quotes, backslashes, no shell, arguments passed verbatim", async () => {
    const r = recorder();
    await openDirectory("C:/Users/x/folder", { platform: "win32", spawn: r.spawn });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.cmd).toEqual(["explorer.exe", '"C:\\Users\\x\\folder"']);
    expect(r.calls[0]!.opts).toEqual({ stdio: ["ignore", "ignore", "ignore"], windowsVerbatimArguments: true });
    expect(r.unrefs()).toBe(1);
  });
  test("Windows: a GUI process, so windowsHide is not set", async () => {
    const r = recorder();
    await openDirectory("C:\\a", { platform: "win32", spawn: r.spawn });
    expect("windowsHide" in r.calls[0]!.opts).toBe(false);
  });
  test("Linux: xdg-open with the absolute folder; macOS: open with the folder", async () => {
    const l = recorder();
    await openDirectory("/home/x/folder", { platform: "linux", spawn: l.spawn });
    expect(l.calls[0]!.cmd).toEqual(["xdg-open", "/home/x/folder"]);
    expect(l.calls[0]!.opts).toEqual({ stdio: ["ignore", "ignore", "ignore"] });
    expect(l.calls[0]!.cmd[1]!.startsWith("/")).toBe(true); // an absolute path can never be read as an option
    const d = recorder();
    await openDirectory("/Users/x/folder", { platform: "darwin", spawn: d.spawn });
    expect(d.calls[0]!.cmd).toEqual(["open", "/Users/x/folder"]);
  });
  test("macOS: a folder whose name has an extension may be an application bundle, so it is only shown (open -R), never opened", () => {
    for (const b of ["/Applications/Foo.app", "/Users/x/Downloads/Setup.pkg", "/Users/x/Setup.mpkg", "/L/x.prefPane", "/L/x.workflow", "/Applications/Foo.app/"]) {
      expect(directoryCommand(b, "darwin"), b).toEqual(["open", "-R", b.replace(/\/$/, "")]);
    }
    expect(directoryCommand("/Users/x/Documents", "darwin")).toEqual(["open", "/Users/x/Documents"]);
    expect(directoryCommand("/Users/x/.config", "darwin")).toEqual(["open", "/Users/x/.config"]);
  });
  test("spaces, accents and shell metacharacters stay inside one argument", () => {
    const names = ["My Folder é ñ 日本", "a & calc", "100% $(whoami) `x`", "semi;colon, comma", "quote's 'n' more", "(1) [2] {3}"];
    for (const n of names) {
      expect(directoryCommand(`C:\\Users\\x\\${n}`, "win32")).toEqual(["explorer.exe", `"C:\\Users\\x\\${n}"`]);
      expect(directoryCommand(`/home/x/${n}`, "linux")).toEqual(["xdg-open", `/home/x/${n}`]);
      expect(directoryCommand(`/Users/x/${n}`, "darwin")).toEqual(["open", `/Users/x/${n}`]);
    }
  });
  test("nothing goes through a shell", () => {
    const shells = ["cmd", "cmd.exe", "sh", "bash", "powershell", "pwsh", "start", "/c", "-c", "/k"];
    for (const [platform, dir] of [["win32", "C:\\a b"], ["linux", "/a b"], ["darwin", "/a b"]] as const) {
      const cmd = directoryCommand(dir, platform);
      expect(cmd).toHaveLength(2);
      for (const s of shells) expect(cmd.map((c) => c.toLowerCase())).not.toContain(s);
    }
  });
  test("a target that explorer or xdg-open could read as a switch, or that cannot be quoted, is refused", () => {
    expect(() => directoryCommand("/select,C:\\x", "win32")).toThrow();
    expect(() => directoryCommand("-x", "linux")).toThrow();
    expect(() => directoryCommand("relative/dir", "darwin")).toThrow();
    expect(() => directoryCommand("\\\\server\\share", "win32")).toThrow();
    expect(() => directoryCommand('C:\\a"b', "win32")).toThrow(); // a quote would end the quoting
    expect(() => directoryCommand("C:\\a\u0007b", "win32")).toThrow();
    expect(() => directoryCommand("C:\\a\\b.", "win32")).toThrow(); // Windows drops a trailing dot or space: another folder
    expect(() => directoryCommand("C:\\a\\b ", "win32")).toThrow();
  });
  test("a start failure is thrown; an exit code is never looked at (explorer.exe says 1 on success)", async () => {
    const failing: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    await expect(openDirectory("C:\\a", { platform: "win32", spawn: failing })).rejects.toThrow("ENOENT");
    const exits1: SpawnFn = () => ({ unref() {}, exited: Promise.resolve(1) } as { unref(): void });
    await expect(openDirectory("C:\\a", { platform: "win32", spawn: exits1 })).resolves.toBeUndefined();
  });
});

describe("revealFile: show a file in its folder without opening it", () => {
  test("Windows: explorer.exe /select, with the path in double quotes, passed verbatim", async () => {
    const r = recorder();
    await revealFile("C:/Users/x/run.exe", { platform: "win32", spawn: r.spawn });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.cmd).toEqual(["explorer.exe", '/select,"C:\\Users\\x\\run.exe"']);
    expect(r.calls[0]!.opts).toEqual({ stdio: ["ignore", "ignore", "ignore"], windowsVerbatimArguments: true });
    expect(r.unrefs()).toBe(1);
  });
  test("Linux has no portable select: it opens the folder that holds the file", async () => {
    const r = recorder();
    await revealFile("/home/x/downloads/setup.sh", { platform: "linux", spawn: r.spawn });
    expect(r.calls[0]!.cmd).toEqual(["xdg-open", "/home/x/downloads"]);
    const root = recorder();
    await revealFile("/setup.sh", { platform: "linux", spawn: root.spawn });
    expect(root.calls[0]!.cmd).toEqual(["xdg-open", "/"]);
  });
  test("macOS: open -R selects the file in Finder", async () => {
    const r = recorder();
    await revealFile("/Users/x/setup.pkg", { platform: "darwin", spawn: r.spawn });
    expect(r.calls[0]!.cmd).toEqual(["open", "-R", "/Users/x/setup.pkg"]);
  });
  test("spaces, accents and shell metacharacters stay inside one argument", () => {
    for (const n of ["My Report é ñ 日本.html", "a & calc.exe", "100% $(whoami) `x`.bat", "semi;colon, comma.cmd"]) {
      expect(revealCommand(`C:\\Users\\x\\${n}`, "win32")).toEqual(["explorer.exe", `/select,"C:\\Users\\x\\${n}"`]);
      expect(revealCommand(`/home/x/${n}`, "linux")).toEqual(["xdg-open", "/home/x"]);
      expect(revealCommand(`/Users/x/${n}`, "darwin")).toEqual(["open", "-R", `/Users/x/${n}`]);
    }
  });
  test("a folder with spaces and accents on Linux is one argument", () => {
    expect(revealCommand("/home/x/Mis Documentos é/informe.exe", "linux")).toEqual(["xdg-open", "/home/x/Mis Documentos é"]);
  });
  test("it never runs the file: no shell, no start, nothing but the file manager", () => {
    const shells = ["cmd", "cmd.exe", "sh", "bash", "powershell", "pwsh", "start", "/c", "-c", "rundll32"];
    for (const [platform, p] of [["win32", "C:\\a b\\run.exe"], ["linux", "/a b/run.sh"], ["darwin", "/a b/run.sh"]] as const) {
      const cmd = revealCommand(p, platform);
      for (const s of shells) expect(cmd.map((c) => c.toLowerCase())).not.toContain(s);
      expect(cmd.some((c) => c === p)).toBe(platform === "darwin"); // only macOS gets the file itself, and as the target of -R
    }
  });
  test("a target that is not absolute, is a network path or cannot be quoted is refused", () => {
    expect(() => revealCommand("run.exe", "win32")).toThrow();
    expect(() => revealCommand("\\\\server\\share\\a.exe", "win32")).toThrow();
    expect(() => revealCommand('C:\\a"b.exe', "win32")).toThrow();
    expect(() => revealCommand("C:\\a\\b.exe.", "win32")).toThrow();
    expect(() => revealCommand("-x/a", "linux")).toThrow();
    expect(() => revealCommand("a.pkg", "darwin")).toThrow();
  });
  test("a start failure is thrown; an exit code is never looked at", async () => {
    const failing: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    await expect(revealFile("C:\\a.exe", { platform: "win32", spawn: failing })).rejects.toThrow("ENOENT");
  });
});

describe("trailing separators and roots on Windows", () => {
  test("a trailing backslash or slash is dropped, so it can never sit in front of the closing quote", () => {
    expect(directoryCommand("C:\\a\\", "win32")).toEqual(["explorer.exe", '"C:\\a"']);
    expect(directoryCommand("C:/x/a,b/", "win32")).toEqual(["explorer.exe", '"C:\\x\\a,b"']);
    expect(directoryCommand("C:\\a b\\\\", "win32")).toEqual(["explorer.exe", '"C:\\a b"']);
    expect(revealCommand("C:\\a\\b.exe\\", "win32")).toEqual(["explorer.exe", '/select,"C:\\a\\b.exe"']);
  });
  test("a drive root is written without quotes (it cannot hold a comma), and cannot be revealed", () => {
    expect(directoryCommand("D:\\", "win32")).toEqual(["explorer.exe", "D:\\"]);
    expect(directoryCommand("d:/", "win32")).toEqual(["explorer.exe", "d:\\"]);
    expect(() => revealCommand("D:\\", "win32")).toThrow();
    expect(() => revealCommand("D:/", "win32")).toThrow();
  });
  test("no quoted argument ends in a backslash", () => {
    for (const p of ["C:\\", "D:\\a\\", "C:/x/", "C:\\a b\\", "C:\\a,b\\\\"]) {
      const arg = directoryCommand(p, "win32")[1]!;
      expect(arg.endsWith('\\"'), p).toBe(false);
    }
  });
});

describe("macOS: only a plain folder is opened", () => {
  const none = () => false;
  test("a folder with a Contents/Info.plist is a bundle whatever its name, so it is shown, not opened", () => {
    const withPlist = (p: string) => p === "/Users/x/Odd/Contents/Info.plist";
    expect(directoryCommand("/Users/x/Odd", "darwin", withPlist)).toEqual(["open", "-R", "/Users/x/Odd"]);
    expect(directoryCommand("/Users/x/Odd/", "darwin", withPlist)).toEqual(["open", "-R", "/Users/x/Odd"]);
    expect(directoryCommand("/Users/x/Plain", "darwin", withPlist)).toEqual(["open", "/Users/x/Plain"]);
  });
  test("a long or unusual extension is still an extension", () => {
    for (const b of ["/L/x.qlgenerator", "/L/x.saver", "/L/x-y.app"]) expect(directoryCommand(b, "darwin", none)[1], b).toBe("-R");
  });
  test("the root is opened as it is, never as open -R with an empty path", () => {
    expect(directoryCommand("/", "darwin", none)).toEqual(["open", "/"]);
    expect(directoryCommand("//", "darwin", none)).toEqual(["open", "/"]);
  });
  test("a real bundle fixture on disk (a temp folder with Contents/Info.plist and no extension)", () => {
    const base = mkdtempSync(join(tmpdir(), "sidecr-bundle-"));
    mkdirSync(join(base, "Odd", "Contents"), { recursive: true });
    writeFileSync(join(base, "Odd", "Contents", "Info.plist"), "<plist/>");
    mkdirSync(join(base, "Plain"));
    // the folders are named with a fake POSIX prefix and mapped onto the temp folder, so this runs on any host
    const onDisk = (p: string) => existsSync(p.replace("/fx", base));
    expect(directoryCommand("/fx/Odd", "darwin", onDisk)).toEqual(["open", "-R", "/fx/Odd"]);
    expect(directoryCommand("/fx/Plain", "darwin", onDisk)).toEqual(["open", "/fx/Plain"]);
  });
});

describe("guiSpawnOptions", () => {
  test("only Windows passes its arguments verbatim (the command line is built by hand there)", () => {
    expect(guiSpawnOptions("win32")).toEqual({ stdio: ["ignore", "ignore", "ignore"], windowsVerbatimArguments: true });
    expect(guiSpawnOptions("linux")).toEqual({ stdio: ["ignore", "ignore", "ignore"] });
    expect(guiSpawnOptions("darwin")).toEqual({ stdio: ["ignore", "ignore", "ignore"] });
  });
});

// The quoting is proved without Explorer: the very same command and spawn options are run against a harmless child that
// reports the raw command line it was started with (test/raw-cmdline.ps1) and how many arguments it was split into.
describe.skipIf(process.platform !== "win32")("Windows command line, as a child process receives it", () => {
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = join(import.meta.dir, "raw-cmdline.ps1");

  async function received(cmd: string[]): Promise<{ raw: string; count: number; args: string[] }> {
    // cmd[0] (explorer.exe) is replaced by the child; everything after it is exactly what Explorer would be given.
    const child = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `"${script}"`, ...cmd.slice(1)], {
      windowsVerbatimArguments: guiSpawnOptions("win32").windowsVerbatimArguments, // the option the opener spawns with
      stdout: "pipe",
    });
    const out = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(out.trim());
  }

  const names = [
    "plain",
    "a,b",
    "My Folder",
    "a, b c",
    "x,sub",
    "(1) (2)",
    "a&b",
    "e,calc.exe",
    "x,\\e,root", // a segment ending in a comma, then a segment that starts like an Explorer switch
    "100% $(whoami) `x`",
    "semi;colon",
    "Città é ñ 日本",
    "a'b",
    "[1] {2}",
  ];

  test("a folder is ONE double-quoted token, whatever is in its name", async () => {
    for (const n of names) {
      const path = `C:\\t\\${n}`;
      const cmd = directoryCommand(path, "win32");
      const got = await received(cmd);
      expect(got.count, n).toBe(1);
      expect(got.args[0], n).toBe(path);
      expect(got.raw.endsWith(` "${path}"`), `${n}: ${got.raw}`).toBe(true);
    }
  }, 60_000);

  test("a file is ONE /select,\"path\" token, whatever is in its name", async () => {
    for (const n of names) {
      const path = `C:\\t\\${n}.bat`;
      const cmd = revealCommand(path, "win32");
      const got = await received(cmd);
      expect(got.count, n).toBe(1);
      expect(got.args[0], n).toBe(`/select,${path}`);
      expect(got.raw.endsWith(` /select,"${path}"`), `${n}: ${got.raw}`).toBe(true);
    }
  }, 60_000);

  test("forward slashes are turned into backslashes", async () => {
    const got = await received(directoryCommand("C:/t/a,b/c", "win32"));
    expect(got.args).toEqual(["C:\\t\\a,b\\c"]);
    expect(got.raw.endsWith(' "C:\\t\\a,b\\c"')).toBe(true);
  }, 60_000);

  // [path as given, the one argument the child must receive, whether that argument is written in quotes]
  const trailing: [string, string, boolean][] = [
    ["D:\\", "D:\\", false], // a root: no quotes, a quoted "D:\" would read as D:"
    ["d:/", "d:\\", false],
    ["C:\\a\\", "C:\\a", true],
    ["C:/x/a,b/", "C:\\x\\a,b", true],
    ["C:\\a b\\", "C:\\a b", true],
    ["C:\\a,b c\\\\", "C:\\a,b c", true],
  ];

  test("a trailing separator or a root never leaves a backslash in front of a closing quote (dir)", async () => {
    for (const [given, one, quoted] of trailing) {
      const got = await received(directoryCommand(given, "win32"));
      expect(got.count, given).toBe(1);
      expect(got.args[0], given).toBe(one);
      expect(got.raw.endsWith(quoted ? ` "${one}"` : ` ${one}`), `${given}: ${got.raw}`).toBe(true);
    }
  }, 60_000);

  test("the same for the file form: /select,\"path\" with no trailing separator, and a root cannot be revealed", async () => {
    for (const [given, one, quoted] of trailing.filter(([, , q]) => q)) {
      const got = await received(revealCommand(given, "win32"));
      expect(got.count, given).toBe(1);
      expect(got.args[0], given).toBe(`/select,${one}`);
      expect(got.raw.endsWith(` /select,"${one}"`), `${given}: ${got.raw}`).toBe(true);
      expect(quoted).toBe(true);
    }
    expect(() => revealCommand("D:\\", "win32")).toThrow();
  }, 60_000);

  test("without the verbatim option Bun would leave the comma bare (why the command line is built by hand)", async () => {
    const child = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "C:\\t\\a,b"], { stdout: "pipe" });
    const out = JSON.parse((await new Response(child.stdout).text()).trim());
    expect(out.raw.endsWith(" C:\\t\\a,b")).toBe(true); // unquoted: this is what the review found
  }, 30_000);
});

describe("openExternal: files and URLs keep their command line", () => {
  test("Windows: rundll32, and NOT windowsHide (rundll32 hands its hidden show state to the program that opens the file)", async () => {
    const r = recorder();
    await openExternal("C:\\a\\b.png", { platform: "win32", spawn: r.spawn });
    expect(r.calls[0]!.cmd).toEqual(["rundll32", "url.dll,FileProtocolHandler", "C:\\a\\b.png"]);
    expect(r.calls[0]!.opts).toEqual({ stdio: ["ignore", "ignore", "ignore"] });
    expect("windowsHide" in r.calls[0]!.opts).toBe(false);
  });
  test("no platform and no kind of target (file, URL, a path with spaces) is spawned with windowsHide", async () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const target of ["C:\\a b\\notes.txt", "/a b/notes.txt", "https://example.com/a?b=c"]) {
        const r = recorder();
        await openExternal(target, { platform, spawn: r.spawn });
        expect(r.calls).toHaveLength(1);
        expect("windowsHide" in r.calls[0]!.opts, `${platform} ${target}`).toBe(false);
        expect(r.calls[0]!.opts.windowsVerbatimArguments, `${platform} ${target}`).toBeUndefined(); // Bun quotes the target itself
        expect(r.calls[0]!.cmd.at(-1)).toBe(target);
      }
    }
  });
  test("macOS and Linux", async () => {
    const d = recorder();
    await openExternal("https://x.dev", { platform: "darwin", spawn: d.spawn });
    expect(d.calls[0]!.cmd).toEqual(["open", "https://x.dev"]);
    const l = recorder();
    await openExternal("/a/b.md", { platform: "linux", spawn: l.spawn });
    expect(l.calls[0]!.cmd).toEqual(["xdg-open", "/a/b.md"]);
  });
});
