import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import allowJson from "./public-hygiene-allow.json";

/*
 * The repository is public: nothing in it may carry the author's local account, machines, mail or private projects, and
 * nothing may look like a credential. This scans every file git tracks (plus new files not ignored yet, so a leak is
 * caught before the commit) and fails with file:line for each hit.
 *
 * A legitimate exception goes in test/public-hygiene-allow.json as { "path", "rule", "text", "reason" }: it exempts only
 * that exact text (`{author}` stands for package.json's author), so a second mention elsewhere in the same file still
 * fails. An entry that no longer matches exactly one line fails too, so the list cannot rot.
 *
 * The patterns below are written with character classes (n[a]me) so that this file never contains the words it looks
 * for: it is scanned like any other file and needs no exemption.
 */

interface Rule {
  id: string;
  what: string;
  re: RegExp;
}

const RULES: Rule[] = [
  // The author's account names, as they appear in paths and in Claude's encoded project folders.
  { id: "windows-user", what: "the author's Windows user name", re: /(?<![\p{L}\p{N}])n[a]zza(?![\p{L}\p{N}])/iu },
  { id: "posix-user", what: "the author's POSIX home", re: /home[\\/-]n[a]zz(?![\p{L}\p{N}])/iu },
  { id: "nickname", what: "the author's nickname", re: /(?<![\p{L}\p{N}.])N[a]zz(?![\p{L}\p{N}.])/u },
  { id: "author-name", what: "the author's surname", re: /(?<![\p{L}\p{N}])g[i]annelli(?![\p{L}\p{N}])/iu },
  { id: "email", what: "the author's e-mail address", re: /n[a]zzareno\.g[i]annelli@|@g[m]ail\.com/i },
  { id: "machine", what: "one of the author's machine names", re: /(?<![\p{L}\p{N}])(?:home[b]east|mini[p]c|n[a]zzux)(?![\p{L}\p{N}])/iu },
  { id: "private-project", what: "a private project, client or vault name", re: /(?<![\p{L}\p{N}])(?:r[3]plica|b[l]its|m[e]dilab|n[a]zzaverse|c[a]milla)(?![\p{L}\p{N}])/iu },
  // Credentials: the well-known token shapes and key headers.
  { id: "private-key", what: "a private key", re: /-----BEGIN [A-Z ]*P[R]IVATE KEY-----/ },
  { id: "github-token", what: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|g[i]thub_pat_[A-Za-z0-9_]{40,})/ },
  { id: "api-key", what: "an API key (Anthropic, OpenAI, AWS, Slack, Google, Stripe)", re: /\b(?:s[k]-(?:ant-)?[A-Za-z0-9_-]{24,}|A[K]IA[0-9A-Z]{16}|x[o]x[abprs]-[A-Za-z0-9-]{10,}|A[I]za[0-9A-Za-z_-]{35}|[sr][k]_(?:live|test)_[0-9A-Za-z]{16,})/ },
  { id: "base64-blob", what: "a long base64 blob (an embedded secret or file)", re: /[A-Za-z0-9+/]{200,}={0,2}/ },
];

/** Files that must never be tracked at all, whatever they contain. */
const FORBIDDEN_PATH = /(?:^|\/)(?:\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|.*\.p12|.*\.pfx|server\.json|settings\.json|drafts\.json|window\.json)$/i;

const BINARY_EXT = /\.(?:png|ico|icns|jpe?g|gif|webp|af)$/i;

interface Allow {
  path: string;
  rule: string;
  text: string;
  reason: string;
}

const root = join(import.meta.dir, "..");
const author = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { author: string }).author;
// The names stay out of the allow-list file itself: {author} is filled in from package.json.
const allow = (allowJson as Allow[]).map((a) => ({ ...a, text: a.text.replaceAll("{author}", author) }));

/** What git tracks plus untracked files that are not ignored; without git, a walk that skips what .gitignore lists. */
function repoFiles(): string[] {
  let git: { exitCode: number | null; stdout: Buffer } | null = null;
  try {
    git = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  } catch {
    /* no git on this machine (a container, a plain download): walk the tree instead */
  }
  if (git && git.exitCode === 0) {
    return [...new Set(git.stdout.toString().split("\0").filter(Boolean))].filter((f) => existsSync(join(root, f))).sort();
  }
  const skip = /^(?:\.git|node_modules|dist|\.state|\.superpowers|spike|shell\/src-tauri\/(?:target[^/]*|gen))(?:\/|$)/;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (skip.test(rel) || rel.endsWith(".log")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

export interface Hit {
  path: string;
  line: number;
  rule: string;
  text: string;
  /** The whole line, for the allow-list check. */
  full: string;
}

/** The hits of one file's text. A binary file is read as Latin-1 and as UTF-16LE, so embedded metadata strings are seen too. */
export function scanText(path: string, text: string, rules: readonly Rule[] = RULES): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const r of rules) {
      const m = r.re.exec(line);
      if (m) hits.push({ path, line: i + 1, rule: r.id, text: line.trim().slice(0, 160), full: line });
    }
  });
  return hits;
}

function scanFile(path: string): Hit[] {
  const bytes = readFileSync(join(root, path));
  const binary = BINARY_EXT.test(path) || bytes.subarray(0, 8000).includes(0);
  // The demo transcript embeds the generated chart image, a PNG in base64 on several lines (checked: each blob starts with the PNG signature).
  if (path === "demo/fixture/session.jsonl") return scanText(path, bytes.toString("utf8"), RULES.filter((r) => r.id !== "base64-blob"));
  if (!binary) return scanText(path, bytes.toString("utf8"));
  // Binary: only the identity rules (a base64 or key shape in compressed bytes is noise), on two decodings.
  const identity = RULES.filter((r) => !["base64-blob", "api-key", "github-token"].includes(r.id));
  const seen = new Set<string>();
  return [...scanText(path, bytes.toString("latin1"), identity), ...scanText(path, bytes.toString("utf16le"), identity)].filter((h) => {
    const k = h.rule;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Allowed when an entry's text is on the line and, with that text taken out, the rule no longer fires on it. */
const allowed = (h: Hit): boolean =>
  allow.some((a) => {
    if (a.path !== h.path || a.rule !== h.rule || !h.full.includes(a.text)) return false;
    const rule = RULES.find((r) => r.id === h.rule)!;
    return !rule.re.test(h.full.split(a.text).join(" "));
  });

describe("public hygiene", () => {
  const files = repoFiles();

  test("the scan sees the repository (and this file, which needs no exemption)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("test/public-hygiene.test.ts");
    expect(files).toContain("README.md");
    expect(files).toContain("herdr-plugin.toml");
  });

  test("no file carries the author's account, machines, mail or private projects, and nothing looks like a credential", () => {
    const hits = files.flatMap(scanFile).filter((h) => !allowed(h));
    expect(hits.map((h) => `${h.path}:${h.line} [${h.rule}] ${h.text}`)).toEqual([]);
  });

  test("no state, credential or environment file is in the repository", () => {
    expect(files.filter((f) => FORBIDDEN_PATH.test(f))).toEqual([]);
  });

  test("every allow-list entry has a reason, a known rule, an existing file, and exempts exactly one line there", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const a of allow) {
      expect(a.reason.trim().length).toBeGreaterThan(10);
      expect(ids.has(a.rule)).toBe(true);
      expect(files).toContain(a.path);
      const exempted = scanFile(a.path).filter((h) => h.rule === a.rule && h.full.includes(a.text));
      expect(exempted.length, `${a.path}: "${a.text}"`).toBe(1);
    }
  });

  test("an exemption covers its own text only: a second mention on the same line or elsewhere still fails", () => {
    const a = allow.find((x) => x.path === "README.md")!;
    const surname = author.split(" ").pop()!;
    const line = (s: string): Hit => ({ path: a.path, line: 1, rule: a.rule, text: s, full: s });
    expect(allowed(line(a.text))).toBe(true);
    expect(allowed(line(`${a.text} Thanks to ${surname} again.`))).toBe(false);
    expect(allowed(line(`Ask ${surname} first.`))).toBe(false);
  });
});

describe("the rules themselves", () => {
  const rulesOf = (s: string) => scanText("x", s).map((h) => h.rule);
  // Built from pieces, so this file stays clean.
  const user = ["n", "a", "z", "z", "a"].join("");
  test("each rule fires on what it is for", () => {
    expect(rulesOf(`C:\\Users\\${user}\\x`)).toContain("windows-user");
    expect(rulesOf(`C--Users-${user}-Vault`)).toContain("windows-user");
    expect(rulesOf(`/home/${user.slice(0, 4)}/x`)).toContain("posix-user");
    expect(rulesOf(`ask ${"N" + user.slice(1, 4)} first`)).toContain("nickname");
    expect(rulesOf(["mini", "pc"].join(""))).toContain("machine");
    expect(rulesOf(["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""))).toContain("private-key");
    expect(rulesOf("x".repeat(0) + "QUJD".repeat(60))).toContain("base64-blob");
    expect(rulesOf(["gh", "p_", "a".repeat(36)].join(""))).toContain("github-token");
  });
  test("what is fine to publish does not fire", () => {
    // The plugin id and the shell identifier keep the author's handle; the GitHub account is public by design.
    expect(rulesOf("id = \"nazz.sidecr\" and dev.nazz.sidecr.test")).toEqual([]);
    expect(rulesOf("herdr plugin install NazzarenoGiannelli/sidecr")).toEqual([]);
    expect(rulesOf("C:\\Users\\alice\\Documents and /home/alice/notes")).toEqual([]);
    expect(rulesOf("integrity: sha512-" + "A".repeat(86) + "==")).toEqual([]);
  });
});
