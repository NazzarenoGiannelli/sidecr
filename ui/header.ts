/** The muted line under the title: "machine · workspace", leaving out whichever part is empty. */
export function headerSubtitle(machine: string | undefined | null, workspace: string | undefined | null): string {
  const parts = [machine, workspace].map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p !== "");
  return parts.join(" · ");
}
