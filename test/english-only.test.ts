import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import allowlistJson from "./english-allowlist.json";

const allowlist = allowlistJson as { file: string; text: string }[];

/*
 * Everything the user sees is English: the window, the notices, the server's error messages, the native shell. This guard reads
 * the code a user can see strings from (ui/, src/, the shell's Rust and HTML) and fails, with file:line, when a string
 * literal has an Italian accented letter or one of a short list of Italian words. Comments, tests and the README are not
 * scanned. A legitimate exception goes in test/english-allowlist.json as { "file": "ui/x.ts", "text": "the literal's text" }
 * (none today).
 */

const root = join(import.meta.dir, "..");
const SCANNED: { dir: string; ext: RegExp }[] = [
  { dir: "ui", ext: /\.(ts|html|css)$/ },
  { dir: "src", ext: /\.ts$/ },
  { dir: "shell/frontend", ext: /\.(html|ts|js)$/ },
  { dir: "shell/src-tauri/src", ext: /\.rs$/ },
];

const ACCENTED = /[àèéìòùÀÈÉÌÒÙ]/;
// Words that are Italian and not English; short ones that exist in English too (per, la, non, con, che) are left out.
const WORDS = [
  "della", "delle", "degli", "dello", "questo", "questa", "questi", "grazie", "errore", "cartella", "cartelle", "impostazioni",
  "messaggio", "messaggi", "apri", "chiudi", "annulla", "invia", "salva", "scegli", "nessun", "nessuna", "sono", "anche", "perche",
  "nuovo", "nuova", "aperto", "trovato", "trovata", "ciao", "benvenuto", "avanti", "indietro", "finestra", "scheda", "conferma",
  "riprova", "attendi", "caricamento", "risposta", "domanda", "ricerca", "cerca", "elimina", "modifica", "copia", "incolla",
];
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${WORDS.join("|")})(?![\\p{L}\\p{N}_])`, "iu");

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;

export interface Finding {
  file: string;
  line: number;
  text: string;
  why: string;
}

/** The string literals of a source line, skipping whole-line comments (the scan is for what the user can see, not for comments). */
function literalsOf(line: string, ext: string): string[] {
  const t = line.trimStart();
  if (ext === "html" || ext === "css") return [line]; // markup: the whole line is visible text or attributes
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
  return line.match(LITERAL) ?? [];
}

export function scan(file: string, source: string, allowed: readonly { file: string; text: string }[] = allowlist): Finding[] {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const out: Finding[] = [];
  source.split(/\r?\n/).forEach((line, i) => {
    for (const lit of literalsOf(line, ext)) {
      const why = ACCENTED.test(lit) ? "an Italian accented letter" : WORD_RE.test(lit) ? "an Italian word" : "";
      if (!why) continue;
      if (allowed.some((a) => a.file === file && lit.includes(a.text))) continue;
      out.push({ file, line: i + 1, text: lit.trim().slice(0, 120), why });
    }
  });
  return out;
}

function filesUnder(dir: string, ext: RegExp): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (n === "node_modules" || n === "target" || n === "target-test" || n === "gen") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p, ext) : ext.test(n) ? [p] : [];
  });
}

describe("the user-facing code is English", () => {
  test("no Italian accented letter or common Italian word in a string the user can see", () => {
    const findings: string[] = [];
    let files = 0;
    for (const { dir, ext } of SCANNED) {
      for (const p of filesUnder(join(root, dir), ext)) {
        files++;
        const rel = relative(root, p).replaceAll("\\", "/");
        for (const f of scan(rel, readFileSync(p, "utf8"))) findings.push(`${f.file}:${f.line}: ${f.why}: ${f.text}`);
      }
    }
    expect(files).toBeGreaterThan(50); // the scan really read the code
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("the allow-list has no entry that matches nothing (it stays honest)", () => {
    for (const a of allowlist) {
      const p = join(root, a.file);
      expect(readFileSync(p, "utf8").includes(a.text), `${a.file}: ${a.text}`).toBe(true);
    }
  });
});

describe("the scanner itself", () => {
  test("it finds accented letters and Italian words in string literals, with the line", () => {
    const src = ['const a = "ok";', 'const b = "Apri la cartella";', "const c = 'perché';", "const d = `Impostazioni`;"].join("\n");
    expect(scan("ui/x.ts", src, []).map((f) => [f.line, f.why])).toEqual([
      [2, "an Italian word"],
      [3, "an Italian accented letter"],
      [4, "an Italian word"],
    ]);
  });
  test("English text, comments and short shared words pass", () => {
    const src = ['// Apri la cartella (a comment)', ' * il messaggio non è qui', 'const a = "Open the folder, per second, non-empty";', 'const b = "Show in folder";'].join("\n");
    expect(scan("ui/x.ts", src, [])).toEqual([]);
  });
  test("a word is matched whole: 'invia' is Italian, 'invianti' and 'inviare' are not in the list", () => {
    expect(scan("ui/x.ts", 'const a = "invianti";', [])).toEqual([]);
    expect(scan("ui/x.ts", 'const a = "Invia";', [])).toHaveLength(1);
  });
  test("html is scanned whole", () => {
    expect(scan("ui/x.html", '<button title="Chiudi">x</button>', [])).toHaveLength(1);
    expect(scan("ui/x.html", '<button title="Close">x</button>', [])).toEqual([]);
  });
  test("an allow-list entry silences exactly its file and text", () => {
    const src = 'const a = "Apri";';
    expect(scan("ui/x.ts", src, [{ file: "ui/x.ts", text: "Apri" }])).toEqual([]);
    expect(scan("ui/y.ts", src, [{ file: "ui/x.ts", text: "Apri" }])).toHaveLength(1);
  });
});
