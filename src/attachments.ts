import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where attachments are saved: SIDECR_ATTACHMENTS_DIR when it is set (resolved to an absolute path), else
 * `attachments` in the state directory.
 */
export function attachmentsDirOf(stateDir: string, env: Record<string, string | undefined> = process.env): string {
  const override = env.SIDECR_ATTACHMENTS_DIR?.trim();
  return resolve(override ? override : join(stateDir, "attachments"));
}

/** Claude Code reads an `@path` mention up to the first whitespace and takes no quotes, so such a folder cannot carry attachments. */
export function hasWhitespace(p: string): boolean {
  return /\s/.test(p);
}

/** The names saveAttachment gives: an optional "N-" collision prefix, then the "yyyymmdd-hhmmss-" stamp. */
const OUR_NAME = /^(?:\d+-)?\d{8}-\d{6}-./;

export function isSidecrAttachmentName(name: string): boolean {
  return OUR_NAME.test(name);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeName(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? "";
  base = base.replace(/[^\w.\-]+/g, "-").replace(/^[.\-]+/, "");
  if (base.length > 80) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
    base = base.slice(0, 80 - ext.length) + ext;
  }
  if (!base || /^\.+$/.test(base)) return "file";
  return RESERVED.test(base) ? `_${base}` : base;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function saveAttachment(dir: string, name: string, bytes: Uint8Array, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${stamp(now)}-${sanitizeName(name)}`;
  let target = resolve(join(dir, base));
  for (let i = 1; existsSync(target); i++) target = resolve(join(dir, `${i}-${base}`));
  writeFileSync(target, bytes, { mode: 0o600 });
  return target;
}

/** Upper bound of the path saveAttachment will produce, to size a message before anything is written. */
export function attachmentPathLength(dir: string, name: string): number {
  // "yyyymmdd-hhmmss-" stamp plus room for the "N-" collision prefix.
  return resolve(join(dir, `00000000-000000-${sanitizeName(name)}`)).length + 8;
}

export function buildMessage(text: string, paths: string[]): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  const mentions = paths.map((p) => `@${p}`).join(" ");
  return [body, mentions].filter(Boolean).join(" ");
}

export function pruneOld(dir: string, maxAgeMs: number, now: number = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let deleted = 0;
  for (const name of readdirSync(dir)) {
    // Only files Sidecr saved: a folder set with SIDECR_ATTACHMENTS_DIR may hold anything else.
    if (!OUR_NAME.test(name)) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile() && now - statSync(p).mtimeMs > maxAgeMs) {
        unlinkSync(p);
        deleted++;
      }
    } catch {
      /* file vanished or locked: leave it */
    }
  }
  return deleted;
}
