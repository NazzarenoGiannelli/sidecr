import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export function findTranscript(sessionId: string, cwd: string, root: string = projectsRoot()): string | null {
  const direct = join(root, encodeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
